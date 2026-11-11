import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommentThread,
  ContentGrant,
  CreatedShareLink,
  GuestCreated,
  LiveEvent,
  PublishResult,
  ShareInfo,
} from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FixedClock } from '../../src/lib/clock.ts';
import { apiInit, createSignedInUser, setupOwner } from '../helpers/auth.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { restClient } from '../helpers/rest.ts';
import { postThread, readSse, sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 11);
const SPA = '<!doctype html><title>SPA</title>';
const PASSWORD = 'Mật khẩu 1';
const RETRY = 'retry: 5000\n\n';

/** Every path M5 adds to the API, relative to `/api/v1`. */
const MEMBER_PATHS = [
  '/artifacts/{id}/comments',
  '/comments/{id}',
  '/comments/{id}/replies',
  '/comments/{id}/resolve',
  '/comments/{id}/reopen',
  '/artifacts/{id}/share-links',
  '/share-links/{id}',
  '/artifacts/{id}/events',
];
const SHARE_VIEWER_PATHS = [
  '/share/{token}',
  '/share/{token}/unlock',
  '/share/{token}/comments',
  '/share/{token}/comments/{id}',
  '/share/{token}/comments/{id}/replies',
  '/share/{token}/events',
];

/** Version 1: an outer page that frames `docs/inner.html`. */
const V1_FILES = [
  {
    path: 'index.html',
    content: '<!doctype html><title>Lịch</title><iframe src="docs/inner.html"></iframe>',
  },
  {
    path: 'docs/inner.html',
    content: '<!doctype html><html><head></head><body><p>Giá vé 100.000 đồng</p></body></html>',
  },
];
/** Version 2 changes the framed page, and its outer page has a BOM and CRLF line ends. */
const V2_INDEX =
  '﻿<!doctype html>\r\n<title>Lịch</title>\r\n<iframe src="docs/inner.html"></iframe>\r\n';
const V2_FILES = [
  { path: 'index.html', content: V2_INDEX },
  {
    path: 'docs/inner.html',
    content: '<!doctype html><html><head></head><body><p>Giá vé 120.000 đồng</p></body></html>',
  },
];

const MODES = [
  ['single-domain', {}],
  ['content-domain', CONTENT_ENV],
] as const;

/** The live event in one SSE message: `event: <type>` then one `data:` line. */
function eventOf(text: string): LiveEvent {
  const match = /^event: ([a-z.]+)\ndata: (.*)\n\n$/.exec(text);
  if (match === null) throw new Error(`Not an event: ${text}`);
  const event = LiveEvent.parse(JSON.parse(match[2] ?? ''));
  expect(event.type).toBe(match[1]);
  return event;
}

describe.each(dialects)('the M5 review flow on %s', (dialect) => {
  let ctx: TestContext;
  let webDir: string;
  const streams: ReturnType<typeof readSse>[] = [];

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'pinwall-web-'));
    await writeFile(join(webDir, 'index.html'), SPA);
  });
  afterEach(async () => {
    for (const stream of streams.splice(0)) await stream.cancel().catch(() => undefined);
    await ctx.close();
    await rm(webDir, { recursive: true, force: true });
  });

  /** Opens a live stream and reads past its `retry` line. */
  async function openStream(path: string, cookie: string) {
    const r = await ctx.request(path, apiInit(ctx, { cookie }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const stream = readSse(r);
    streams.push(stream);
    expect(await stream.next()).toBe(RETRY);
    return stream;
  }

  test.each(MODES)(
    'a thread on v1 resolves in v2 with live events, and share links stay byte-for-byte (%s)',
    async (_mode, env) => {
      const clock = new FixedClock(T);
      ctx = await createTestContext({
        dialect,
        clock,
        env: { ...env, PINWALL_WEB_DIR: webDir },
      });

      // 1. The owner sets the instance up; a member publishes v1, a page that frames another.
      await setupOwner(ctx);
      const member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
      const api = restClient(ctx, member.cookie);
      const first = await api.post('/publish/inline', { target: {}, files: V1_FILES });
      expect(first.status).toBe(201);
      const v1 = PublishResult.parse(first.body);
      expect(v1.version_number).toBe(1);
      const id = v1.artifact_id;

      // 2. The member opens the artifact's live stream. A review preview of v1 serves the
      //    annotator tag in both the outer page and the framed one.
      const live = await openStream(`/api/v1/artifacts/${id}/events`, member.cookie);
      const preview = await api.get(`/artifacts/${id}/versions/1/preview?mode=review`);
      expect(preview.status).toBe(200);
      const grant = ContentGrant.parse(preview.body);
      expect(grant.mode).toBe('review');
      const tag = `<script src="${grant.url}__pinwall/annotator.js" data-pinwall-annotator></script>`;
      for (const path of ['', 'docs/inner.html']) {
        const page = await ctx.request(new URL(path, grant.url).href);
        expect(page.status, path).toBe(200);
        expect(page.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
        expect(await page.text(), path).toContain(tag);
      }
      const script = await ctx.request(`${grant.url}__pinwall/annotator.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

      // 3. The member pins a thread on text in the framed page of v1.
      clock.advance(1000);
      const anchor = sampleAnchor({
        page: 'docs/inner.html',
        quote: { exact: '100.000 đồng', prefix: 'Giá vé ', suffix: '' },
        dom: { path: 'body > p' },
      });
      const thread = await postThread(ctx, member.cookie, id, {
        body: 'Giá này đã cũ',
        anchor,
        versionId: v1.version_id,
      });
      expect(thread).toMatchObject({ status: 'open', version: { number: 1 }, anchor });
      const created = eventOf(await live.next());
      expect(created).toMatchObject({
        type: 'comment.created',
        artifact_id: id,
        thread: { id: thread.id, status: 'open' },
      });

      // 4. v2 is published on top of v1; the stream announces it.
      clock.advance(1000);
      const second = await api.post('/publish/inline', {
        target: { artifact_id: id, expected_version_id: v1.version_id },
        files: V2_FILES,
      });
      expect(second.status).toBe(201);
      const v2 = PublishResult.parse(second.body);
      expect(v2.version_number).toBe(2);
      expect(eventOf(await live.next())).toEqual({
        type: 'version.published',
        artifact_id: id,
        version_id: v2.version_id,
        number: 2,
      });

      // 5. Resolving the thread says it was resolved in v2, and the stream announces that.
      clock.advance(1000);
      const resolved = await api.post(`/comments/${thread.id}/resolve`, {});
      expect(resolved.status).toBe(200);
      expect(CommentThread.parse(resolved.body)).toMatchObject({
        id: thread.id,
        status: 'resolved',
        resolved_in_version: { id: v2.version_id, number: 2 },
      });
      expect(eventOf(await live.next())).toMatchObject({
        type: 'comment.resolved',
        artifact_id: id,
        thread: { id: thread.id, resolved_in_version: { id: v2.version_id, number: 2 } },
      });

      // 6. A link with a password that allows comments: locked until unlocked, then a guest
      //    writes a thread and both its stream and the member's hear it.
      clock.advance(1000);
      const commentLink = await api.post(`/artifacts/${id}/share-links`, {
        password: PASSWORD,
        allow_comments: true,
      });
      expect(commentLink.status).toBe(201);
      const withComments = CreatedShareLink.parse(commentLink.body);
      const viewerPage = await ctx.request(`/s/${withComments.token}`, {
        headers: { accept: 'text/html' },
      });
      expect(viewerPage.status).toBe(200);
      expect(await viewerPage.text()).toBe(SPA);
      const locked = await ctx.request(`/api/v1/share/${withComments.token}`);
      expect(locked.status).toBe(401);
      expect(await locked.json()).toMatchObject({
        error: { code: 'unauthorized', details: { password_required: true } },
      });
      const unlocked = await ctx.request(
        `/api/v1/share/${withComments.token}/unlock`,
        apiInit(ctx, { body: { password: PASSWORD } }),
      );
      expect(unlocked.status).toBe(204);
      const unlockCookie = unlocked.headers.getSetCookie()[0]?.split(';')[0] ?? '';
      expect(unlockCookie).toMatch(/pinwall_share=v1\./);
      const shown = ShareInfo.parse(
        await (
          await ctx.request(
            `/api/v1/share/${withComments.token}`,
            apiInit(ctx, { cookie: unlockCookie }),
          )
        ).json(),
      );
      expect(shown).toMatchObject({
        version_number: 2,
        follows_current: true,
        allow_comments: true,
        content: { mode: 'review' },
      });

      const shareLive = await openStream(
        `/api/v1/share/${withComments.token}/events`,
        unlockCookie,
      );
      clock.advance(1000);
      const guest = await ctx.request(
        `/api/v1/share/${withComments.token}/comments`,
        apiInit(ctx, {
          cookie: unlockCookie,
          body: {
            guest_name: 'Lan',
            body: 'Đẹp quá',
            anchor: sampleAnchor({ page: 'docs/inner.html' }),
          },
        }),
      );
      expect(guest.status).toBe(201);
      const guestThread = GuestCreated.parse(await guest.json()).thread;
      expect(guestThread.author).toEqual({ type: 'guest', name: 'Lan' });
      for (const stream of [shareLive, live]) {
        expect(eventOf(await stream.next())).toMatchObject({
          type: 'comment.created',
          artifact_id: id,
          thread: { id: guestThread.id, author: { type: 'guest', name: 'Lan' } },
        });
      }

      // 7. A link without comments serves the stored bytes, until it is revoked.
      const plainLink = await api.post(`/artifacts/${id}/share-links`, { allow_comments: false });
      expect(plainLink.status).toBe(201);
      const plain = CreatedShareLink.parse(plainLink.body);
      const redirect = await ctx.request(`/s/${plain.token}`);
      expect(redirect.status).toBe(302);
      const rawUrl = redirect.headers.get('location') ?? '';
      const raw = await ctx.request(rawUrl);
      expect(raw.status).toBe(200);
      expect(Buffer.from(await raw.arrayBuffer()).equals(Buffer.from(V2_INDEX))).toBe(true);
      const rawInner = await ctx.request(new URL('docs/inner.html', rawUrl).href);
      expect(await rawInner.text()).toBe(V2_FILES[1]?.content);

      const revoked = await api.del(`/share-links/${plain.link.id}`);
      expect(revoked.status).toBe(204);
      expect((await ctx.request(`/s/${plain.token}`)).status).toBe(410);
      expect((await ctx.request(rawUrl)).status).toBe(410);

      // 8. The API document lists every M5 path.
      const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      for (const path of [...MEMBER_PATHS, ...SHARE_VIEWER_PATHS]) {
        expect(doc.paths, path).toHaveProperty([path]);
      }
    },
  );
});
