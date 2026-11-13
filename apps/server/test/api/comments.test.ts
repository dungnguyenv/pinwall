import {
  ArtifactList,
  ArtifactSummary,
  Comment,
  CommentThread,
  CommentThreadList,
  LiveEvent,
} from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { listThreads } from '../../src/domain/comments.ts';
import { deleteVersion } from '../../src/domain/deletion.ts';
import { ARTIFACT_TOPIC } from '../../src/domain/search.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../../src/lib/ids.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';
import { postThread, sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 11);

type Member = { user: UserRow; cookie: string };

describe.each(dialects)('comment threads on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  /** The artifact's publisher. */
  let pub: Member;
  /** Two other members. */
  let m: Member;
  let o: Member;
  let admin: Member;
  let id: string;
  let v1: VersionRow;
  let v2: VersionRow;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    pub = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    m = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });
    o = await createSignedInUser(ctx, { kind: 'oidc', name: 'Oanh' });
    admin = await createSignedInUser(ctx, { kind: 'oidc', idpRole: 'admin', name: 'An' });
    const first = await publishFiles(ctx, pub.user, { 'index.html': '<p>một</p>' });
    clock.advance(1000);
    const second = await publishFiles(
      ctx,
      pub.user,
      { 'index.html': '<p>hai</p>' },
      { kind: 'new_version', artifactId: first.artifact.id, expectedVersionId: first.version.id },
    );
    id = first.artifact.id;
    v1 = first.version;
    v2 = second.version;
    clock.advance(1000);
  });
  afterEach(() => ctx.close());

  const api = (who: Member) => restClient(ctx, who.cookie);

  /** Opens a thread as `who`, one second after whatever came before. */
  async function thread(who: Member, opts: { body?: string; versionId?: string } = {}) {
    clock.advance(1000);
    return postThread(ctx, who.cookie, id, opts);
  }

  async function reply(who: Member, commentId: string, body = 'Đồng ý') {
    clock.advance(1000);
    const r = await api(who).post(`/comments/${commentId}/replies`, { body });
    expect(r.status).toBe(201);
    return Comment.parse(r.body);
  }

  async function list(query = '') {
    const r = await api(m).get(`/artifacts/${id}/comments${query}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    return CommentThreadList.parse(r.body);
  }

  /** Another artifact, published by `pub`, and its only version. */
  async function otherArtifact() {
    return publishFiles(ctx, pub.user, { 'index.html': '<p>khác</p>' });
  }

  test('a member opens a thread on the current version', async () => {
    const r = await ctx.request(
      `/api/v1/artifacts/${id}/comments`,
      apiInit(ctx, {
        method: 'POST',
        cookie: m.cookie,
        body: { body: ' Sửa giá ', anchor: sampleAnchor() },
      }),
    );
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const th = (await r.json()) as { id: string };
    expect(th).toMatchObject({
      body: 'Sửa giá',
      status: 'open',
      version: { id: v2.id, number: 2 },
      anchor: sampleAnchor(),
      thread_id: th.id,
      author: { type: 'member', user_id: m.user.id, name: m.user.name },
      replies: [],
      edited_at: null,
      resolved_in_version: null,
    });
    expect(CommentThread.parse(th)).toEqual({
      id: th.id,
      thread_id: th.id,
      artifact_id: id,
      version: { id: v2.id, number: 2 },
      author: { type: 'member', user_id: m.user.id, name: 'Minh' },
      body: 'Sửa giá',
      created_at: clock.now(),
      updated_at: clock.now(),
      edited_at: null,
      anchor: sampleAnchor(),
      status: 'open',
      resolved_in_version: null,
      resolved_by: null,
      resolved_at: null,
      replies: [],
    });
    expect(th.id).toMatch(/^cmt_/);
    expect((await list()).items).toEqual([th]);
  });

  test('a thread can be written on an older version', async () => {
    const old = await thread(m, { versionId: v1.id });
    expect(old.version).toEqual({ id: v1.id, number: 1 });

    const other = await otherArtifact();
    const r = await api(m).post(`/artifacts/${id}/comments`, {
      body: 'x',
      anchor: sampleAnchor(),
      version_id: other.version.id,
    });
    expect(r.status).toBe(400);
    expect((r.body as ErrorJson).error.message).toBe(t('version.notInArtifact'));
    const unknown = await api(m).post(`/artifacts/${id}/comments`, {
      body: 'x',
      anchor: sampleAnchor(),
      version_id: 'ver_nope',
    });
    expect(unknown.status).toBe(400);

    const missing = await api(m).post('/artifacts/art_nope/comments', {
      body: 'x',
      anchor: sampleAnchor(),
    });
    expect(missing.status).toBe(404);
    expect((missing.body as ErrorJson).error.message).toBe(t('artifact.notFound'));
  });

  test('replies form a flat thread, oldest first', async () => {
    const root = await thread(m, { versionId: v1.id });
    const first = await reply(o, root.id, ' Đồng ý ');
    expect(first).toEqual({
      id: first.id,
      thread_id: root.id,
      artifact_id: id,
      version: { id: v1.id, number: 1 },
      author: { type: 'member', user_id: o.user.id, name: 'Oanh' },
      body: 'Đồng ý',
      created_at: clock.now(),
      updated_at: clock.now(),
      edited_at: null,
    });
    const second = await reply(m, first.id, 'Đã sửa');
    expect(second.thread_id).toBe(root.id);

    const [listed] = (await list()).items;
    expect(listed?.id).toBe(root.id);
    expect(listed?.replies.map((c) => [c.id, c.body])).toEqual([
      [first.id, 'Đồng ý'],
      [second.id, 'Đã sửa'],
    ]);
    const raw = (await api(m).get(`/artifacts/${id}/comments`)).body as {
      items: { replies: Record<string, unknown>[] }[];
    };
    for (const c of raw.items[0]?.replies ?? []) {
      expect(c.thread_id).toBe(root.id);
      expect(c).not.toHaveProperty('anchor');
      expect(c).not.toHaveProperty('status');
    }

    const nowhere = await api(m).post('/comments/cmt_nope/replies', { body: 'x' });
    expect(nowhere.status).toBe(404);
    expect((nowhere.body as ErrorJson).error.message).toBe(t('comment.notFound'));
  });

  test('list returns thread trees filtered by status and version', async () => {
    const a = await thread(m, { versionId: v1.id });
    const b = await thread(o);
    const c = await thread(m);
    await reply(o, b.id);
    expect((await api(m).post(`/comments/${a.id}/resolve`, {})).status).toBe(200);

    const all = await list();
    expect(all.items.map((th) => th.id)).toEqual([a.id, b.id, c.id]);
    expect(all.items[1]?.replies).toHaveLength(1);
    expect(all.next_cursor).toBeNull();
    expect((await list('?status=open')).items.map((th) => th.id)).toEqual([b.id, c.id]);
    expect((await list('?status=resolved')).items.map((th) => th.id)).toEqual([a.id]);
    expect((await list('?status=all')).items).toHaveLength(3);
    expect((await list('?version=1')).items.map((th) => th.id)).toEqual([a.id]);
    expect((await list('?version=2&status=open')).items.map((th) => th.id)).toEqual([b.id, c.id]);
    expect((await list('?version=7')).items).toEqual([]);

    const page1 = await list('?limit=2');
    expect(page1.items.map((th) => th.id)).toEqual([a.id, b.id]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await list(`?limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? '')}`);
    expect(page2.items.map((th) => th.id)).toEqual([c.id]);
    expect(page2.next_cursor).toBeNull();

    for (const bad of ['?cursor=garbage', '?status=closed', '?version=0', '?limit=201']) {
      expect((await api(m).get(`/artifacts/${id}/comments${bad}`)).status).toBe(400);
    }
    expect((await api(m).get('/artifacts/art_nope/comments')).status).toBe(404);
  });

  test('threads written at the same moment page by id', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await postThread(ctx, m.cookie, id));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await list(query);
      seen.push(...page.items.map((th) => th.id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(made.map((th) => th.id).sort());
  });

  test('only the author edits, and edits set edited_at', async () => {
    const root = await thread(m);
    const created = root.created_at;
    clock.advance(5000);
    const r = await api(m).patch(`/comments/${root.id}`, { body: ' Giá mới ' });
    expect(r.status).toBe(200);
    expect(Comment.parse(r.body)).toMatchObject({
      id: root.id,
      body: 'Giá mới',
      created_at: created,
      updated_at: clock.now(),
      edited_at: clock.now(),
    });
    expect(r.body).not.toHaveProperty('replies');
    expect((await list()).items[0]).toMatchObject({ body: 'Giá mới', edited_at: clock.now() });

    const x = await reply(o, root.id);
    const own = await api(o).patch(`/comments/${x.id}`, { body: 'Sửa lại' });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: x.id, thread_id: root.id, body: 'Sửa lại' });

    for (const who of [o, pub, admin]) {
      const refused = await api(who).patch(`/comments/${root.id}`, { body: 'Không' });
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorJson).error.message).toBe(t('comment.editForbidden'));
    }
    expect((await api(m).patch('/comments/cmt_nope', { body: 'x' })).status).toBe(404);
    expect((await list()).items[0]?.body).toBe('Giá mới');
  });

  test('the author, the publisher or an admin deletes; deleting a root deletes its thread', async () => {
    const root = await thread(m);
    const x = await reply(m, root.id);
    const y = await reply(o, root.id);
    await reply(o, root.id);

    const refused = await api(o).del(`/comments/${x.id}`);
    expect(refused.status).toBe(403);
    expect((refused.body as ErrorJson).error.message).toBe(t('comment.deleteForbidden'));
    const ownRoot = await api(o).del(`/comments/${root.id}`);
    expect(ownRoot.status).toBe(403);

    const mine = await api(m).del(`/comments/${x.id}`);
    expect(mine.status).toBe(204);
    expect(mine.body).toBeNull();
    expect((await api(pub).del(`/comments/${y.id}`)).status).toBe(204);
    expect((await list()).items[0]?.replies).toHaveLength(1);

    expect((await api(admin).del(`/comments/${root.id}`)).status).toBe(204);
    expect(await ctx.deps.db.db.selectFrom('comments').select('id').execute()).toEqual([]);
    const gone = await api(m).del(`/comments/${root.id}`);
    expect(gone.status).toBe(404);
    expect((gone.body as ErrorJson).error.message).toBe(t('comment.notFound'));
  });

  test('resolve defaults to the current version, reopen clears it', async () => {
    const root = await thread(m, { versionId: v1.id });
    clock.advance(1000);
    const r = await api(m).post(`/comments/${root.id}/resolve`, {});
    expect(r.status).toBe(200);
    expect(CommentThread.parse(r.body)).toMatchObject({
      status: 'resolved',
      resolved_in_version: { id: v2.id, number: 2 },
      resolved_by: { user_id: m.user.id, name: 'Minh' },
      resolved_at: clock.now(),
    });
    expect((await list()).items[0]?.status).toBe('resolved');

    clock.advance(1000);
    const reopened = await api(o).post(`/comments/${root.id}/reopen`);
    expect(reopened.status).toBe(200);
    expect(CommentThread.parse(reopened.body)).toMatchObject({
      status: 'open',
      resolved_in_version: null,
      resolved_by: null,
      resolved_at: null,
    });

    // A resolve with no body at all is a resolve in the current version.
    const bare = await ctx.request(
      `/api/v1/comments/${root.id}/resolve`,
      apiInit(ctx, { method: 'POST', cookie: o.cookie }),
    );
    expect(bare.status).toBe(200);
    expect(CommentThread.parse(await bare.json())).toMatchObject({
      status: 'resolved',
      resolved_in_version: { number: 2 },
      resolved_by: { user_id: o.user.id },
    });
    expect((await api(m).post('/comments/cmt_nope/resolve', {})).status).toBe(404);
    expect((await api(m).post('/comments/cmt_nope/reopen')).status).toBe(404);
  });

  test('resolve names a version of the same artifact; replies cannot be resolved', async () => {
    const root = await thread(m);
    const r = await api(m).post(`/comments/${root.id}/resolve`, { version_id: v1.id });
    expect(r.status).toBe(200);
    expect(CommentThread.parse(r.body).resolved_in_version).toEqual({ id: v1.id, number: 1 });

    const other = await otherArtifact();
    const foreign = await api(m).post(`/comments/${root.id}/resolve`, {
      version_id: other.version.id,
    });
    expect(foreign.status).toBe(400);
    expect((foreign.body as ErrorJson).error.message).toBe(t('version.notInArtifact'));

    const x = await reply(o, root.id);
    for (const action of ['resolve', 'reopen']) {
      const refused = await api(m).post(`/comments/${x.id}/${action}`, {});
      expect(refused.status).toBe(400);
      expect((refused.body as ErrorJson).error.message).toBe(t('comment.notThread'));
    }
    expect((await list()).items[0]?.resolved_in_version).toEqual({ id: v1.id, number: 1 });
  });

  test('a thread on v1 resolved in v2 survives deleting v2 with no resolving version', async () => {
    const root = await thread(m, { versionId: v1.id });
    await thread(o);
    expect((await api(m).post(`/comments/${root.id}/resolve`, {})).status).toBe(200);

    await deleteVersion(ctx.deps, { user: pub.user, via: 'session' }, id, 2);
    const { items } = await list();
    expect(items.map((th) => th.id)).toEqual([root.id]);
    expect(items[0]).toMatchObject({
      status: 'resolved',
      resolved_in_version: null,
      resolved_by: { user_id: m.user.id },
    });
  });

  test('comments need a member and a valid body and anchor', async () => {
    const root = await thread(m);
    expect((await ctx.request(`/api/v1/artifacts/${id}/comments`)).status).toBe(401);
    const anonymous = await ctx.request(
      `/api/v1/artifacts/${id}/comments`,
      apiInit(ctx, { body: { body: 'x', anchor: sampleAnchor() } }),
    );
    expect(anonymous.status).toBe(401);
    const anonymousReply = await ctx.request(
      `/api/v1/comments/${root.id}/replies`,
      apiInit(ctx, { body: { body: 'x' } }),
    );
    expect(anonymousReply.status).toBe(401);

    const post = (body: unknown) => api(m).post(`/artifacts/${id}/comments`, body);
    expect((await post({ body: '   ', anchor: sampleAnchor() })).status).toBe(400);
    expect((await post({ body: 'b'.repeat(10_001), anchor: sampleAnchor() })).status).toBe(400);
    expect((await post({ body: 'b'.repeat(10_000), anchor: sampleAnchor() })).status).toBe(201);
    const noQuote = await post({ body: 'x', anchor: sampleAnchor({ quote: undefined }) });
    expect(noQuote.status).toBe(400);
    const issues = (noQuote.body as ErrorJson).error.details?.issues as { path: string }[];
    expect(issues[0]?.path).toBe('anchor.quote');
    expect((await post({ body: 'x' })).status).toBe(400);
    // A page with a dot segment would lead the review frame out of the version's own files.
    for (const page of ['../../a/x/raw', 'docs/..', './']) {
      const away = await post({ body: 'x', anchor: sampleAnchor({ page }) });
      expect(away.status).toBe(400);
      const pageIssues = (away.body as ErrorJson).error.details?.issues as { path: string }[];
      expect(pageIssues[0]?.path).toBe('anchor.page');
    }

    expect((await api(m).post(`/comments/${root.id}/replies`, { body: ' ' })).status).toBe(400);
    expect((await api(m).patch(`/comments/${root.id}`, { body: '' })).status).toBe(400);
  });

  test('comments of a deleted artifact are gone', async () => {
    const root = await thread(m);
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: id, expiresAt: null }],
      clock.now(),
    );
    await ctx.deps.db.db.deleteFrom('artifacts').where('id', '=', id).execute();

    const r = await api(m).get(`/artifacts/${id}/comments`);
    expect(r.status).toBe(410);
    expect((r.body as ErrorJson).error.message).toBe(t('artifact.gone'));
    expect(
      (await api(m).post(`/artifacts/${id}/comments`, { body: 'x', anchor: sampleAnchor() }))
        .status,
    ).toBe(410);
    expect((await api(m).post(`/comments/${root.id}/replies`, { body: 'x' })).status).toBe(404);
  });

  test('changes are published on the artifact topic', async () => {
    const seen: LiveEvent[] = [];
    ctx.deps.events.subscribe(ARTIFACT_TOPIC(id), (e) => seen.push(LiveEvent.parse(e)));

    const root = await thread(m);
    const x = await reply(o, root.id);
    expect((await api(o).patch(`/comments/${x.id}`, { body: 'Sửa lại' })).status).toBe(200);
    expect((await api(m).post(`/comments/${root.id}/resolve`, {})).status).toBe(200);
    expect((await api(m).post(`/comments/${root.id}/reopen`)).status).toBe(200);
    expect((await api(o).del(`/comments/${x.id}`)).status).toBe(204);
    expect((await api(m).del(`/comments/${root.id}`)).status).toBe(204);

    expect(seen.map((e) => e.type)).toEqual([
      'comment.created',
      'comment.created',
      'comment.updated',
      'comment.resolved',
      'comment.reopened',
      'comment.deleted',
      'comment.deleted',
    ]);
    expect(seen.every((e) => e.artifact_id === id)).toBe(true);
    expect(seen[0]).toMatchObject({ thread: { id: root.id, replies: [] } });
    expect(seen[1]).toMatchObject({ thread: { id: root.id, replies: [{ id: x.id }] } });
    expect(seen[2]).toMatchObject({ thread: { replies: [{ id: x.id, body: 'Sửa lại' }] } });
    expect(seen[3]).toMatchObject({ thread: { status: 'resolved' } });
    expect(seen[4]).toMatchObject({ thread: { status: 'open' } });
    expect(seen[5]).toMatchObject({
      comment_id: x.id,
      thread_id: root.id,
      version_number: 2,
      thread: { id: root.id, replies: [] },
    });
    expect(seen[6]).toMatchObject({ comment_id: root.id, thread_id: root.id, thread: null });

    // A refused change publishes nothing.
    await api(o).patch(`/comments/${root.id}`, { body: 'x' });
    expect(seen).toHaveLength(7);
  });

  test('a page of threads costs the same queries whatever its size', async () => {
    for (let i = 0; i < 6; i++) {
      const root = await thread(i % 2 === 0 ? m : o, { versionId: i < 3 ? v1.id : v2.id });
      await reply(o, root.id);
      await reply(m, root.id);
      if (i % 3 === 0) await api(admin).post(`/comments/${root.id}/resolve`, {});
    }
    const queries = async (limit: number): Promise<number> => {
      let seen = 0;
      const counting = ctx.deps.db.db.withPlugin({
        transformQuery: ({ node }) => {
          seen += 1;
          return node;
        },
        transformResult: async ({ result }) => result,
      });
      const deps = { ...ctx.deps, db: { ...ctx.deps.db, db: counting } };
      const { items } = await listThreads(deps, SYSTEM_SCOPE, id, {
        status: 'all',
        limit,
        cursor: null,
      });
      expect(items).toHaveLength(limit);
      expect(items.every((th) => th.replies.length === 2)).toBe(true);
      return seen;
    };
    const one = await queries(1);
    expect(one).toBeGreaterThan(0);
    expect(await queries(6)).toBe(one);
  });

  test('artifact summaries count open threads and active share links', async () => {
    const a = await thread(m);
    await thread(o);
    const resolved = await thread(m);
    await reply(o, a.id);
    expect((await api(m).post(`/comments/${resolved.id}/resolve`, {})).status).toBe(200);

    const now = clock.now();
    const link = (at: { expiresAt?: number | null; revokedAt?: number | null }) => ({
      id: newId('shr'),
      artifact_id: id,
      version_id: null,
      token_hash: hashSecret(newSecret()),
      password_hash: null,
      allow_comments: 0 as const,
      expires_at: at.expiresAt ?? null,
      created_by: pub.user.id,
      created_at: now,
      last_used_at: null,
      revoked_at: at.revokedAt ?? null,
    });
    await ctx.deps.db.db
      .insertInto('share_links')
      .values([
        link({}),
        link({ revokedAt: now - 1 }),
        link({ expiresAt: now - 1 }),
        link({ expiresAt: now }),
        link({ expiresAt: now + 60_000, revokedAt: now }),
      ])
      .execute();

    const summary = ArtifactSummary.parse((await api(m).get(`/artifacts/${id}`)).body);
    expect(summary).toMatchObject({ open_thread_count: 2, share_link_count: 1 });

    const other = await otherArtifact();
    const all = ArtifactList.parse((await api(m).get('/artifacts')).body);
    const counts = Object.fromEntries(
      all.items.map((s) => [s.id, [s.open_thread_count, s.share_link_count]]),
    );
    expect(counts).toEqual({ [id]: [2, 1], [other.artifact.id]: [0, 0] });
  });

  test('the API document describes the comment routes', async () => {
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.paths['/artifacts/{id}/comments'] ?? {}).sort()).toEqual([
      'get',
      'post',
    ]);
    expect(Object.keys(doc.paths['/comments/{id}'] ?? {}).sort()).toEqual(['delete', 'patch']);
    for (const action of ['replies', 'resolve', 'reopen']) {
      expect(Object.keys(doc.paths[`/comments/{id}/${action}`] ?? {})).toEqual(['post']);
    }
  });
});
