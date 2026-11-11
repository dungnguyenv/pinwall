import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sessionCookieName } from '../../src/auth/session-cookie.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);

let dir: string;
let single: TestContext | undefined;
let contentDomain: TestContext | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinwall-switch-'));
});
afterEach(async () => {
  await single?.close();
  await contentDomain?.close();
  await rm(dir, { recursive: true, force: true });
});

test('switching the isolation mode keeps links working with identical bytes', async () => {
  const clock = new FixedClock(T);
  // One data dir before and after the switch: the same database and blobs, another mode.
  single = await createTestContext({ env: { PINWALL_DATA_DIR: dir }, clock });
  contentDomain = await createTestContext({
    env: { PINWALL_DATA_DIR: dir, ...CONTENT_ENV },
    clock,
  });

  const { user, cookie } = await createSignedInUser(single);
  // The same session, carried under the cookie name of the https origin.
  const secret = cookie.slice(cookie.indexOf('=') + 1);
  const cookies = new Map([
    [single, cookie],
    [contentDomain, `${sessionCookieName(contentDomain.deps.config)}=${secret}`],
  ]);

  const html = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('<!doctype html>\r\n<title>Đơn hàng</title>\r\n<img src="a.png">\r\n'),
  ]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    randomBytes(300),
  ]);
  const video = randomBytes(1000);
  const { artifact } = await publishFiles(single, user, {
    'index.html': html,
    'a.png': png,
    'v.mp4': video,
  });

  const seen = new Map<TestContext, { etag: string | null; location: string }>();
  for (const ctx of [single, contentDomain]) {
    const mode = ctx.deps.config.isolation.mode;
    const r = await ctx.request(`/a/${artifact.id}/raw`, {
      headers: { cookie: cookies.get(ctx) ?? '' },
      redirect: 'manual',
    });
    expect(r.status, mode).toBe(302);
    const location = r.headers.get('location') ?? '';
    expect(location, mode).toMatch(
      mode === 'single-domain'
        ? /^http:\/\/localhost:8080\/c\/[0-9a-hjkmnp-tv-z]{32}\/$/
        : /^https:\/\/[0-9a-hjkmnp-tv-z]{32}\.pw-content\.test\/$/,
    );

    const page = await ctx.app.request(location);
    expect(page.status, mode).toBe(200);
    expect(Buffer.from(await page.arrayBuffer()).equals(html), mode).toBe(true);
    const image = await ctx.app.request(`${location}a.png`);
    expect(Buffer.from(await image.arrayBuffer()).equals(png), mode).toBe(true);
    const range = await ctx.app.request(`${location}v.mp4`, { headers: { range: 'bytes=10-19' } });
    expect(range.status, mode).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).equals(video.subarray(10, 20)), mode).toBe(true);
    seen.set(ctx, { etag: page.headers.get('etag'), location });

    const versioned = await ctx.request(`/a/${artifact.id}/v/1/raw`, {
      headers: { cookie: cookies.get(ctx) ?? '' },
      redirect: 'manual',
    });
    expect(versioned.status, mode).toBe(302);
    const again = await ctx.app.request(versioned.headers.get('location') ?? '');
    expect(Buffer.from(await again.arrayBuffer()).equals(html), mode).toBe(true);
  }

  const before = seen.get(single);
  const after = seen.get(contentDomain);
  expect(before?.etag).toMatch(/^"[0-9a-f]{64}"$/);
  expect(after?.etag).toBe(before?.etag);

  // A content URL is never a link to keep: after the switch, `/c/*` is not served at all.
  const stale = await contentDomain.request(new URL(before?.location ?? '').pathname);
  expect(stale.status).toBe(404);
});
