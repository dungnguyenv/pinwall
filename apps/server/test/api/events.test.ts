import { type CommentThread, LiveEvent } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthContext } from '../../src/app.ts';
import { sessionCookieName } from '../../src/auth/session-cookie.ts';
import { createSession, deleteUserSessions } from '../../src/auth/sessions.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { deleteArtifact, deleteVersion } from '../../src/domain/deletion.ts';
import { ARTIFACT_TOPIC } from '../../src/domain/search.ts';
import { UNLOCK_MAX_MS } from '../../src/domain/share-access.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { restoreVersion } from '../../src/domain/versions.ts';
import { SSE_HEARTBEAT_MS, SSE_MAX_BUFFERED_BYTES } from '../../src/http/sse.ts';
import type { InProcessEventBus } from '../../src/infra/event-bus.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import { postThread, readSse } from '../helpers/review.ts';
import { listen } from '../helpers/socket.ts';

const T = Date.UTC(2026, 10, 11);
const PW = 'Mật khẩu 1';
const RETRY = 'retry: 5000\n\n';
const PING = ': ping\n\n';
/** How long a stream that should stay open is watched for an end. */
const STAYS_OPEN_MS = 300;

/** Only the heartbeat's interval is faked: sockets, the database and `readSse` keep real time. */
const fakeHeartbeat = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

/** The event in one SSE message, checked to be `event: <type>` then one `data:` line. */
function eventOf(text: string): LiveEvent {
  const match = /^event: ([a-z.]+)\ndata: (.*)\n\n$/.exec(text);
  if (match === null) throw new Error(`Not an event: ${text}`);
  const event = LiveEvent.parse(JSON.parse(match[2] ?? ''));
  expect(event.type).toBe(match[1]);
  return event;
}

/** The message `version.published` makes, byte for byte. */
const published = (artifactId: string, v: VersionRow) =>
  `event: version.published\ndata: ${JSON.stringify({
    type: 'version.published',
    artifact_id: artifactId,
    version_id: v.id,
    number: v.number,
  })}\n\n`;

describe.each(dialects)('live updates on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let server: Awaited<ReturnType<typeof listen>>;
  /** The artifact's publisher, an IdP member. */
  let m: { user: UserRow; cookie: string };
  let id: string;
  let v1: VersionRow;
  let topic: string;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    server = await listen(ctx.app, ctx.deps.config);
    m = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    const first = await publishFiles(ctx, m.user, { 'index.html': '<p>một</p>' });
    id = first.artifact.id;
    v1 = first.version;
    topic = ARTIFACT_TOPIC(id);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
    await ctx.close();
  });

  const bus = () => ctx.deps.events as InProcessEventBus;
  const memberPath = () => `/api/v1/artifacts/${id}/events`;
  const sharePath = (token: string) => `/api/v1/share/${token}/events`;

  /** A GET over a real socket to the test server. */
  function open(
    path: string,
    o: { cookie?: string; bearer?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (o.cookie !== undefined) headers.cookie = o.cookie;
    if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers,
      ...(o.signal ? { signal: o.signal } : {}),
    });
  }

  /** A stream over a real socket, read past its `retry` line. */
  async function stream(path: string, o: { cookie?: string; signal?: AbortSignal } = {}) {
    const r = await open(path, o);
    if (r.status !== 200) throw new Error(`GET ${path} answered ${r.status}: ${await r.text()}`);
    const s = readSse(r);
    expect(await s.next()).toBe(RETRY);
    return s;
  }

  /** Counts the stream's unsubscribe calls, through the real bus. */
  function watchUnsubscribes() {
    const unsubscribed = vi.fn();
    const events = ctx.deps.events;
    const subscribe = events.subscribe.bind(events);
    vi.spyOn(events, 'subscribe').mockImplementation((name, handler) => {
      const off = subscribe(name, handler);
      return () => {
        unsubscribed();
        off();
      };
    });
    return unsubscribed;
  }

  async function newSession(user: UserRow): Promise<string> {
    const { secret } = await createSession(ctx.deps, user.id, 'oidc', {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    return `${sessionCookieName(ctx.deps.config)}=${secret}`;
  }

  async function publishVersion(expected: VersionRow, html: string): Promise<VersionRow> {
    clock.advance(1000);
    const target = { kind: 'new_version' as const, artifactId: id, expectedVersionId: expected.id };
    return (await publishFiles(ctx, m.user, { 'index.html': html }, target)).version;
  }

  async function share(
    o: Partial<{
      versionId: string | null;
      password: string | null;
      expiresAt: number | null;
      allowComments: boolean;
    }> = {},
  ) {
    const { row, token } = await createShareLink(ctx.deps, m.user, id, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: true,
      ...o,
    });
    return { linkId: row.id, token };
  }

  const memberAuth = (): AuthContext => ({ user: m.user, via: 'session' });

  /** Moves the faked interval on to the next heartbeat: a ping, then the access check. */
  const heartbeat = () => vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);

  test('a stream starts with retry and carries the SSE headers', async () => {
    const r = await open(memberPath(), { cookie: m.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(r.headers.get('x-accel-buffering')).toBe('no');
    const s = readSse(r);
    expect(await s.next()).toBe(RETRY);
    await s.cancel();

    // HEAD answers with the headers and opens nothing.
    for (const path of [memberPath(), sharePath((await share()).token)]) {
      const head = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'HEAD',
        headers: { cookie: m.cookie },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    }
    await vi.waitFor(() => expect(bus().subscriberCount(topic)).toBe(0));
    expect(ctx.deps.liveStreams.size).toBe(0);
  });

  test('a heartbeat comment every 25 seconds', async () => {
    fakeHeartbeat();
    const s = await stream(memberPath(), { cookie: m.cookie });
    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS - 1);
    // Nothing yet: the next message is the thread posted now.
    const thread = await postThread(ctx, m.cookie, id);
    expect(eventOf(await s.next())).toMatchObject({ thread: { id: thread.id } });
    await vi.advanceTimersByTimeAsync(1);
    expect(await s.next()).toBe(PING);
    await heartbeat();
    expect(await s.next()).toBe(PING);
    // Access still holds, so the stream stays open.
    expect(await s.done(STAYS_OPEN_MS)).toBe(false);
  });

  test('publishing a version reaches open streams', async () => {
    const s = await stream(memberPath(), { cookie: m.cookie });
    const v2 = await publishVersion(v1, '<p>hai</p>');
    expect(await s.next()).toBe(published(id, v2));
    // A restore is a new version too.
    const v3 = (await restoreVersion(ctx.deps, m.user, id, 1, v2.id)).version;
    expect(await s.next()).toBe(published(id, v3));
  });

  test('comment events reach open streams', async () => {
    const s = await stream(memberPath(), { cookie: m.cookie });
    const thread = await postThread(ctx, m.cookie, id);
    const text = await s.next();
    expect(text.startsWith('event: comment.created\n')).toBe(true);
    // Members see who wrote it.
    expect(eventOf(text)).toMatchObject({
      type: 'comment.created',
      artifact_id: id,
      thread: { id: thread.id, author: { type: 'member', user_id: m.user.id, name: 'Linh' } },
    });
    const api = restClient(ctx, m.cookie);
    expect((await api.post(`/comments/${thread.id}/resolve`, {})).status).toBe(200);
    expect(eventOf(await s.next())).toMatchObject({
      type: 'comment.resolved',
      thread: { id: thread.id, resolved_in_version: { id: v1.id, number: 1 } },
    });
    expect((await api.del(`/comments/${thread.id}`)).status).toBe(204);
    expect(eventOf(await s.next())).toEqual({
      type: 'comment.deleted',
      artifact_id: id,
      thread_id: thread.id,
      comment_id: thread.id,
      version_number: 1,
      thread: null,
    });
  });

  test('version deletion is announced; artifact deletion ends the stream', async () => {
    await publishVersion(v1, '<p>hai</p>');
    const s = await stream(memberPath(), { cookie: m.cookie });
    await deleteVersion(ctx.deps, memberAuth(), id, 1);
    expect(await s.next()).toBe(
      `event: version.deleted\ndata: ${JSON.stringify({ type: 'version.deleted', artifact_id: id, number: 1 })}\n\n`,
    );
    await deleteArtifact(ctx.deps, memberAuth(), id);
    expect(await s.next()).toBe(
      `event: artifact.deleted\ndata: ${JSON.stringify({ type: 'artifact.deleted', artifact_id: id })}\n\n`,
    );
    expect(await s.done()).toBe(true);
    expect(bus().subscriberCount(topic)).toBe(0);
  });

  test('closing the request unsubscribes and stops the heartbeat', async () => {
    fakeHeartbeat();
    const unsubscribed = watchUnsubscribes();
    const ended = async (calls: number) => {
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(calls));
      expect(bus().subscriberCount(topic)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(ctx.deps.liveStreams.size).toBe(0);
    };

    // The browser drops the connection.
    const aborted = new AbortController();
    await stream(memberPath(), { cookie: m.cookie, signal: aborted.signal });
    expect(bus().subscriberCount(topic)).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(ctx.deps.liveStreams.size).toBe(1);
    aborted.abort();
    await ended(1);

    // The client stops reading and closes the body.
    const s = await stream(memberPath(), { cookie: m.cookie });
    expect(bus().subscriberCount(topic)).toBe(1);
    await s.cancel();
    await ended(2);

    // Each on its own is enough: the request's abort signal, and the body's cancel.
    const signalled = new AbortController();
    await ctx.request(memberPath(), { headers: { cookie: m.cookie }, signal: signalled.signal });
    expect(bus().subscriberCount(topic)).toBe(1);
    signalled.abort();
    await ended(3);
    const r = await ctx.request(memberPath(), { headers: { cookie: m.cookie } });
    expect(bus().subscriberCount(topic)).toBe(1);
    await r.body?.cancel();
    await ended(4);

    // Nothing more happens to a closed stream.
    await heartbeat();
    await postThread(ctx, m.cookie, id);
    expect(unsubscribed).toHaveBeenCalledTimes(4);
  });

  test('member streams need a browser session and end with it', async () => {
    const viaToken = await open(memberPath(), { bearer: await createUserToken(ctx, m.user.id) });
    expect(viaToken.status).toBe(403);
    expect(await viaToken.json()).toMatchObject({
      error: { code: 'forbidden', message: t('auth.sessionRequired') },
    });
    expect((await open(memberPath())).status).toBe(401);
    const missing = await open('/api/v1/artifacts/art_nope/events', { cookie: m.cookie });
    expect(missing.status).toBe(404);

    fakeHeartbeat();
    const { db } = ctx.deps.db;
    const setUser = (change: Partial<Pick<UserRow, 'role_override' | 'idp_checked_at'>>) =>
      db.updateTable('users').set(change).where('id', '=', m.user.id).execute();

    // Revoke now (every session of the user ends) closes the stream at the next heartbeat.
    const revoked = await stream(memberPath(), { cookie: m.cookie });
    await deleteUserSessions(ctx.deps, m.user.id);
    await heartbeat();
    expect(await revoked.done()).toBe(true);

    // So does a block, but not a heartbeat while access holds.
    const blocked = await stream(memberPath(), { cookie: await newSession(m.user) });
    await heartbeat();
    expect(await blocked.done(STAYS_OPEN_MS)).toBe(false);
    await setUser({ role_override: 'blocked' });
    await heartbeat();
    expect(await blocked.done()).toBe(true);
    await setUser({ role_override: null });

    // A session that expired.
    const cookie = await newSession(m.user);
    const expired = await stream(memberPath(), { cookie });
    await db
      .updateTable('sessions')
      .set({ expires_at: clock.now() })
      .where('user_id', '=', m.user.id)
      .execute();
    await heartbeat();
    expect(await expired.done()).toBe(true);

    // An IdP check that is no longer recent enough to act on.
    const stale = await stream(memberPath(), { cookie: await newSession(m.user) });
    await setUser({ idp_checked_at: clock.now() - ctx.deps.config.access.recheckIntervalMs });
    await heartbeat();
    expect(await stale.done()).toBe(true);
    expect(bus().subscriberCount(topic)).toBe(0);
  });

  test('share streams follow the link', async () => {
    const follows = await share();
    const pinned = await share({ versionId: v1.id });
    const quiet = await share({ allowComments: false });
    const f = await stream(sharePath(follows.token));
    const p = await stream(sharePath(pinned.token));
    const q = await stream(sharePath(quiet.token));
    const sharedTexts: string[] = [];
    const next = async (s: Awaited<ReturnType<typeof stream>>) => {
      const text = await s.next();
      sharedTexts.push(text);
      return text;
    };

    // A link that follows the current version hears of new versions; a per-version one does not.
    const v2 = await publishVersion(v1, '<p>hai</p>');
    expect(await next(f)).toBe(published(id, v2));
    expect(await next(q)).toBe(published(id, v2));

    // Threads on v2 reach the following link only, with the member by name.
    const t2 = await postThread(ctx, m.cookie, id, { versionId: v2.id });
    expect(eventOf(await next(f))).toMatchObject({
      type: 'comment.created',
      thread: { id: t2.id, author: { type: 'member', user_id: null, name: 'Linh' } },
    });
    const t1 = await postThread(ctx, m.cookie, id, { versionId: v1.id });
    expect(eventOf(await next(f))).toMatchObject({ thread: { id: t1.id } });
    expect(eventOf(await next(p))).toMatchObject({
      type: 'comment.created',
      thread: { id: t1.id, version: { number: 1 }, author: { user_id: null } },
    });

    // Resolved in v3: the per-version link learns that it was, not in which version.
    const v3 = await publishVersion(v2, '<p>ba</p>');
    expect(await next(f)).toBe(published(id, v3));
    expect(await next(q)).toBe(published(id, v3));
    const resolved = await restClient(ctx, m.cookie).post(`/comments/${t1.id}/resolve`, {
      version_id: v3.id,
    });
    expect(resolved.status).toBe(200);
    expect(eventOf(await next(f))).toMatchObject({
      type: 'comment.resolved',
      thread: { resolved_in_version: { number: 3 }, resolved_by: { user_id: null } },
    });
    expect(eventOf(await next(p))).toMatchObject({
      type: 'comment.resolved',
      thread: {
        id: t1.id,
        status: 'resolved',
        resolved_in_version: null,
        resolved_by: { user_id: null, name: 'Linh' },
      },
    });

    // A version the per-version link does not show is not its business.
    await deleteVersion(ctx.deps, memberAuth(), id, 2);
    const v2Deleted = `event: version.deleted\ndata: ${JSON.stringify({ type: 'version.deleted', artifact_id: id, number: 2 })}\n\n`;
    expect(await next(f)).toBe(v2Deleted);
    expect(await next(q)).toBe(v2Deleted);
    expect((await restClient(ctx, m.cookie).del(`/comments/${t1.id}`)).status).toBe(204);
    for (const s of [f, p]) {
      expect(eventOf(await next(s))).toMatchObject({ type: 'comment.deleted', comment_id: t1.id });
    }

    // The link without comments hears of versions only.
    const v4 = await publishVersion(v3, '<p>bốn</p>');
    expect(await next(q)).toBe(published(id, v4));
    expect(await next(f)).toBe(published(id, v4));
    await deleteArtifact(ctx.deps, memberAuth(), id);
    for (const s of [f, p, q]) {
      expect(eventOf(await next(s)).type).toBe('artifact.deleted');
      expect(await s.done()).toBe(true);
    }
    for (const text of sharedTexts) expect(text).not.toContain(m.user.id);
  });

  test('share streams end when the link is revoked or the unlock lapses', async () => {
    fakeHeartbeat();
    const link = await share();
    const revoked = await stream(sharePath(link.token));
    await heartbeat();
    expect(await revoked.done(STAYS_OPEN_MS)).toBe(false);
    await revokeShareLink(ctx.deps, m.user, link.linkId);
    await heartbeat();
    expect(await revoked.done()).toBe(true);

    const expiring = await share({ expiresAt: clock.now() + 60_000 });
    const expired = await stream(sharePath(expiring.token));
    clock.advance(60_000);
    await heartbeat();
    expect(await expired.done()).toBe(true);

    const locked = await share({ password: PW });
    const unlock = await ctx.request(
      `/api/v1/share/${locked.token}/unlock`,
      apiInit(ctx, { method: 'POST', body: { password: PW } }),
    );
    expect(unlock.status).toBe(204);
    const cookie = unlock.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const unlocked = await stream(sharePath(locked.token), { cookie });
    clock.advance(UNLOCK_MAX_MS - 1);
    await heartbeat();
    expect(await unlocked.done(STAYS_OPEN_MS)).toBe(false);
    clock.advance(1);
    await heartbeat();
    expect(await unlocked.done()).toBe(true);
    expect(bus().subscriberCount(topic)).toBe(0);
  });

  test('a locked share stream is refused', async () => {
    const locked = await share({ password: PW });
    const r = await open(sharePath(locked.token));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({
      error: {
        code: 'unauthorized',
        message: t('share.passwordRequired'),
        details: { password_required: true },
      },
    });
    expect((await open(sharePath('x'.repeat(43)))).status).toBe(404);
    const revoked = await share();
    await revokeShareLink(ctx.deps, m.user, revoked.linkId);
    expect((await open(sharePath(revoked.token))).status).toBe(410);
    expect(bus().subscriberCount(topic)).toBe(0);
  });

  test('a consumer that stops reading is cut off', async () => {
    const unsubscribed = watchUnsubscribes();
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    const thread = await postThread(ctx, m.cookie, id, { body: 'x'.repeat(10_000) });
    /** A valid event of about 100 KB: the thread with ten long replies. */
    const big: LiveEvent = {
      type: 'comment.updated',
      artifact_id: id,
      thread: { ...thread, replies: Array.from({ length: 10 }, () => replyOf(thread)) },
    };
    const size = Buffer.byteLength(`event: ${big.type}\ndata: ${JSON.stringify(big)}\n\n`);
    // The stream holds 64 KiB, then lets a reader fall 1 MiB behind on top.
    const room = 65_536 + SSE_MAX_BUFFERED_BYTES - Buffer.byteLength(RETRY);
    const fits = Math.floor(room / size);

    // In process nobody reads, so the count is exact.
    const r = await ctx.request(memberPath(), { headers: { cookie: m.cookie } });
    for (let i = 0; i < fits; i++) ctx.deps.events.publish(topic, big);
    expect(unsubscribed).not.toHaveBeenCalled();
    ctx.deps.events.publish(topic, big);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ topic }, 'live stream reader fell behind; cut off');
    await expect(r.text()).rejects.toThrow();

    // Over a socket, the connection is cut once the buffers between fill up.
    const s = await stream(memberPath(), { cookie: m.cookie });
    let sent = 0;
    while (unsubscribed.mock.calls.length === 1 && sent < 1000) {
      ctx.deps.events.publish(topic, big);
      sent++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(sent * size).toBeGreaterThan(SSE_MAX_BUFFERED_BYTES);
    const drain = async () => {
      for (;;) await s.next();
    };
    await expect(drain()).rejects.toThrow();
    expect(bus().subscriberCount(topic)).toBe(0);
  });

  test('events that fail LiveEvent are dropped', async () => {
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    const s = await stream(memberPath(), { cookie: m.cookie });
    ctx.deps.events.publish(topic, { type: 'version.published' });
    expect(warn).toHaveBeenCalledWith(
      { topic, type: 'version.published' },
      'invalid live event dropped',
    );
    // The stream goes on: the next message is the next valid event.
    const thread = await postThread(ctx, m.cookie, id);
    expect(eventOf(await s.next())).toMatchObject({ thread: { id: thread.id } });
  });

  test('shutting down ends open streams', async () => {
    const member = await stream(memberPath(), { cookie: m.cookie });
    const shared = await stream(sharePath((await share()).token));
    await ctx.close();
    expect(await member.done()).toBe(true);
    expect(await shared.done()).toBe(true);
    expect(bus().subscriberCount(topic)).toBe(0);
    expect(ctx.deps.liveStreams.size).toBe(0);
  });

  test('the API document lists both streams', async () => {
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, { content?: object }> }>>;
    };
    for (const path of ['/artifacts/{id}/events', '/share/{token}/events']) {
      expect(Object.keys(doc.paths[path]?.get?.responses['200']?.content ?? {})).toEqual([
        'text/event-stream',
      ]);
    }
  });
});

/** A reply in `thread`, written by its author, 10,000 characters long. */
function replyOf(thread: CommentThread): CommentThread['replies'][number] {
  const { id, thread_id, artifact_id, version, author, created_at, updated_at, edited_at } = thread;
  return {
    id: `${id}r`,
    thread_id,
    artifact_id,
    version,
    author,
    body: 'y'.repeat(10_000),
    created_at,
    updated_at,
    edited_at,
  };
}
