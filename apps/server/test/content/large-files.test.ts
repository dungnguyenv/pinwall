import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { contentUrl, createGrant, type GrantMode } from '../../src/content/grants.ts';
import { REVIEW_HTML_HELD_BYTES, REVIEW_HTML_MAX_BYTES } from '../../src/content/serve.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const MARK = 'data-pinwall-annotator';

/** An HTML page of exactly `size` bytes. */
function pageOf(size: number): string {
  const open = '<!doctype html><html><head></head><body><p>';
  const close = '</p></body></html>';
  return open + 'x'.repeat(size - open.length - close.length) + close;
}

describe('large files', () => {
  let ctx: TestContext;
  let owner: UserRow;
  /** Bytes read so far out of the streams the blob store handed out. */
  let read = 0;

  beforeEach(async () => {
    ctx = await createTestContext();
    owner = (await createSignedInUser(ctx)).user;
    read = 0;
    const get = ctx.deps.blobs.get.bind(ctx.deps.blobs);
    async function* counted(stream: Readable): AsyncGenerator<Buffer> {
      for await (const chunk of stream) {
        read += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
    }
    vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (key, range) =>
      Readable.from(counted(await get(key, range)), { objectMode: false }),
    );
  });
  afterEach(() => ctx.close());

  /**
   * Publishes `files` and returns a new grant of `mode` on the version, for the owner. What the
   * publish read of the store is not counted in `read`.
   */
  async function grantOf(files: Record<string, string | Buffer>, mode: GrantMode) {
    const { version } = await publishFiles(ctx, owner, files);
    read = 0;
    return (await createGrant(ctx.deps, { versionId: version.id, mode, user: owner })).token;
  }

  test('a large file streams from the blob store while it is sent, and ranges still serve its bytes', async () => {
    const bytes = randomBytes(8_000_000);
    const token = await grantOf({ 'index.html': '<p>x</p>', 'big.bin': bytes }, 'raw');

    const whole = await fetchContent(ctx, token, 'big.bin');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe(String(bytes.length));
    expect(whole.headers.get('etag')).toBe(`"${sha256(bytes)}"`);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    // The answer is under way while most of the file is still in the store.
    expect(read).toBeLessThan(bytes.length / 4);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);

    const part = await fetchContent(ctx, token, 'big.bin', {
      headers: { range: 'bytes=1000000-1000099' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1000000-1000099/${bytes.length}`);
    expect(part.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(1_000_000, 1_000_100));

    const tail = await fetchContent(ctx, token, 'big.bin', { headers: { range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(bytes.subarray(-10));
  });

  test(`review HTML over ${REVIEW_HTML_MAX_BYTES} bytes is served as stored, streamed, without the annotator`, async () => {
    const page = pageOf(REVIEW_HTML_MAX_BYTES + 1);
    const token = await grantOf({ 'index.html': page }, 'review');

    const res = await fetchContent(ctx, token, '');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${sha256(page)}"`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(page.length));
    expect(res.headers.get('cache-control')).toBe('private, max-age=300, no-transform');
    expect(read).toBeLessThan(page.length / 4);
    const body = await res.text();
    expect(body).toBe(page);
    expect(body).not.toContain(MARK);

    const part = await fetchContent(ctx, token, 'index.html', { headers: { range: 'bytes=0-14' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('<!doctype html>');

    // HEAD never opens the blob.
    const before = vi.mocked(ctx.deps.blobs.get).mock.calls.length;
    const head = await fetchContent(ctx, token, '', { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(page.length));
    expect(vi.mocked(ctx.deps.blobs.get).mock.calls.length).toBe(before);
  });

  test(`review HTML of ${REVIEW_HTML_MAX_BYTES} bytes still carries the annotator`, async () => {
    const page = pageOf(REVIEW_HTML_MAX_BYTES);
    const token = await grantOf({ 'index.html': page }, 'review');
    const res = await fetchContent(ctx, token, '');
    const body = await res.text();
    expect(body.split(MARK)).toHaveLength(2);
    expect(res.headers.get('accept-ranges')).toBeNull();
    expect(res.headers.get('etag')).toBe(`"${sha256(body)}"`);
  });

  test('review pages held in memory at once are bounded: one that does not fit is served as stored, and not cached', async () => {
    const page = pageOf(REVIEW_HTML_MAX_BYTES);
    const fits = Math.floor(REVIEW_HTML_HELD_BYTES / REVIEW_HTML_MAX_BYTES);
    const token = await grantOf({ 'index.html': page }, 'review');
    const stored = `"${sha256(page)}"`;
    const get = (init?: RequestInit) => fetchContent(ctx, token, '', init);
    const annotated = (res: Response) => res.headers.get('etag') !== stored;

    // A HEAD and a 304 hold nothing once answered.
    const etag = (await get({ method: 'HEAD' })).headers.get('etag') ?? '';
    for (let i = 0; i <= fits; i += 1) {
      expect(annotated(await get({ method: 'HEAD' }))).toBe(true);
      expect((await get({ headers: { 'if-none-match': etag } })).status).toBe(304);
    }

    // Answers whose bodies nobody reads yet: each holds its page.
    const held: Response[] = [];
    for (let i = 0; i < fits; i += 1) {
      const res = await get();
      expect(annotated(res), `page ${i}`).toBe(true);
      held.push(res);
    }
    const plain = await get();
    expect(annotated(plain)).toBe(false);
    expect(plain.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(await plain.text()).toBe(page);

    // A client that goes away gives its page back, and so does one that reads it to its end.
    await held.shift()?.body?.cancel();
    const next = await get();
    expect(annotated(next)).toBe(true);
    expect(await next.text()).toContain(MARK);
    const again = await get();
    expect(annotated(again)).toBe(true);
    held.push(again);
    expect(annotated(await get({ method: 'HEAD' }))).toBe(false);

    expect(await held.shift()?.text()).toContain(MARK);
    expect(annotated(await get({ method: 'HEAD' }))).toBe(true);
    // Taken again by a client that goes away before anything reads or cancels its answer. The
    // request is kept: the server holds it until it closes, and with it the signal.
    const client = new AbortController();
    const request = new Request(contentUrl(ctx.deps.config, token), { signal: client.signal });
    held.push(await ctx.app.request(request));
    expect(annotated(await get({ method: 'HEAD' }))).toBe(false);
    client.abort();
    expect(annotated(await get({ method: 'HEAD' }))).toBe(true);
    for (const res of held) await res.body?.cancel();
  });
});
