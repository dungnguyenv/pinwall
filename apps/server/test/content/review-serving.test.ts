import { createHash } from 'node:crypto';
import { ShareInfo } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { annotatorScript } from '../../src/content/annotator-asset.ts';
import { annotatorTag } from '../../src/content/annotator-inject.ts';
import { contentBaseUrl, createGrant, type GrantMode } from '../../src/content/grants.ts';
import { CONTENT_SANDBOX_CSP } from '../../src/content/serve.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV, fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const MARK = 'data-pinwall-annotator';

const FILES = {
  'index.html':
    '<!doctype html>\r\n<html><head></head><body><iframe src="docs/inner.html"></iframe>',
  'docs/inner.html':
    `<!DOCTYPE html><HTML><HEAD><meta http-equiv="Content-Security-Policy" content="script-src 'none'">` +
    '<title>Bảng giá</title></HEAD><body><p>Giá mới</p>',
  'a.css': 'p { color: red }',
  'notes.md': '# Hi',
};

/** How many times `part` occurs in `whole`. */
const count = (whole: string, part: string) => whole.split(part).length - 1;

describe.each([
  ['single-domain', {}],
  ['content-domain', CONTENT_ENV],
] as const)('review serving in %s mode', (mode, env) => {
  let ctx: TestContext;
  let owner: UserRow;

  beforeEach(async () => {
    ctx = await createTestContext({ env: { ...env } });
    owner = (await createSignedInUser(ctx)).user;
  });
  afterEach(() => ctx.close());

  /** Publishes `FILES` as a new artifact. */
  async function publish() {
    const { artifact, version } = await publishFiles(ctx, owner, FILES);
    return { artifactId: artifact.id, versionId: version.id };
  }

  /** The token of a new grant of `grantMode` on `versionId`, for the owner. */
  async function grantOn(versionId: string, grantMode: GrantMode): Promise<string> {
    return (await createGrant(ctx.deps, { versionId, mode: grantMode, user: owner })).token;
  }

  test('review HTML carries the tag in every page and frame; raw HTML never does', async () => {
    const { versionId } = await publish();
    const token = await grantOn(versionId, 'review');
    const tag = annotatorTag(contentBaseUrl(ctx.deps.config, token));

    const pages = new Map<string, string>();
    for (const path of ['', 'index.html', 'docs/inner.html', 'notes.md']) {
      const r = await fetchContent(ctx, token, path);
      const body = await r.text();
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(count(body, tag), path).toBe(1);
      expect(count(body, MARK), path).toBe(1);
      expect(r.headers.get('content-length'), path).toBe(String(Buffer.byteLength(body)));
      expect(r.headers.get('etag'), path).toBe(`"${sha256(body)}"`);
      expect(r.headers.get('accept-ranges'), path).toBeNull();
      pages.set(path, body);
    }
    // Only the tag is added: right after <head>, and in the frame after the page's own policy.
    const index = FILES['index.html'].replace('<head>', `<head>${tag}`);
    expect(pages.get('')).toBe(index);
    expect(pages.get('index.html')).toBe(index);
    expect(pages.get('docs/inner.html')).toBe(
      FILES['docs/inner.html'].replace(`'none'">`, `'none'">${tag}`),
    );
    expect(pages.get('notes.md')).toMatch(
      new RegExp(`^<!doctype html><html><head>${escapeRe(tag)}<meta charset="utf-8">`),
    );
    const head = await fetchContent(ctx, token, 'index.html', { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(index)));

    const css = await fetchContent(ctx, token, 'a.css');
    expect(await css.text()).toBe(FILES['a.css']);
    expect(css.headers.get('etag')).toBe(`"${sha256(FILES['a.css'])}"`);
    const source = await fetchContent(ctx, token, 'notes.md?source');
    expect(await source.text()).toBe(FILES['notes.md']);

    const raw = await grantOn(versionId, 'raw');
    for (const path of ['index.html', 'docs/inner.html'] as const) {
      const r = await fetchContent(ctx, raw, path);
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(FILES[path])), path).toBe(true);
      expect(r.headers.get('etag'), path).toBe(`"${sha256(FILES[path])}"`);
      expect(r.headers.get('etag'), path).not.toBe(`"${sha256(pages.get(path) ?? '')}"`);
    }
    const rawMarkdown = await (await fetchContent(ctx, raw, 'notes.md')).text();
    expect(rawMarkdown).toContain('<h1');
    expect(rawMarkdown).not.toContain(MARK);
  });

  test('the annotator script is served from __pinwall with content headers', async () => {
    const script = annotatorScript();
    expect(script.toString()).toContain('__pinwallAnnotator');
    const { versionId } = await publish();
    for (const grant of [await grantOn(versionId, 'review'), await grantOn(versionId, 'raw')]) {
      const r = await fetchContent(ctx, grant, '__pinwall/annotator.js');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('private, max-age=300, no-transform');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toBe(
        mode === 'single-domain' ? CONTENT_SANDBOX_CSP : null,
      );
      expect(r.headers.get('content-length')).toBe(String(script.length));
      expect(Buffer.from(await r.arrayBuffer()).equals(script)).toBe(true);
    }
  });

  test('share links without comments stay byte-for-byte', async () => {
    const { artifactId } = await publish();
    const { token } = await createShareLink(ctx.deps, owner, artifactId, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: false,
    });

    const r = await ctx.request(`/s/${token}`);
    expect(r.status).toBe(302);
    const page = await ctx.request(r.headers.get('location') ?? '');
    const bytes = Buffer.from(await page.arrayBuffer());
    expect(bytes.equals(Buffer.from(FILES['index.html']))).toBe(true);
    expect(bytes.toString()).not.toContain(MARK);

    // The share viewer's API hands out the same raw content.
    const info = ShareInfo.parse(
      await (await ctx.request(`/api/v1/share/${token}`, apiInit(ctx))).json(),
    );
    expect(info.content.mode).toBe('raw');
    const viaInfo = Buffer.from(await (await ctx.request(info.content.url)).arrayBuffer());
    expect(viaInfo.equals(Buffer.from(FILES['index.html']))).toBe(true);
  });

  test('a share viewer review grant is injected', async () => {
    const { artifactId } = await publish();
    const { token } = await createShareLink(ctx.deps, owner, artifactId, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: true,
    });
    const r = await ctx.request(`/api/v1/share/${token}`, apiInit(ctx));
    expect(r.status).toBe(200);
    const info = ShareInfo.parse(await r.json());
    expect(info.content.mode).toBe('review');

    const page = await (await ctx.request(info.content.url)).text();
    expect(page).toBe(
      FILES['index.html'].replace('<head>', `<head>${annotatorTag(info.content.url)}`),
    );
    const frame = await (await ctx.request(`${info.content.url}docs/inner.html`)).text();
    expect(count(frame, annotatorTag(info.content.url))).toBe(1);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
