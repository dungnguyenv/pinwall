import {
  Comment,
  CommentThreadList,
  GuestCreated,
  type GuestReplyRequest,
  type GuestThreadRequest,
  LiveEvent,
} from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { GUEST_EDIT_WINDOW_MS, GUEST_TOKEN_HEADER } from '../../src/domain/comments.ts';
import { ARTIFACT_TOPIC } from '../../src/domain/search.ts';
import { SHARE_RATES } from '../../src/domain/share-access.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';
import { postThread, sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 11);
const PW = 'Mật khẩu 1';

interface LinkOptions {
  versionId: string | null;
  password: string | null;
  expiresAt: number | null;
  allowComments: boolean;
}

type RequestOptions = Parameters<typeof apiInit>[1];

describe.each(dialects)('guest comments through share links on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  /** The artifact's publisher. */
  let member: { user: UserRow; cookie: string };
  let artifactId: string;
  let v1: VersionRow;
  /** A link that follows the current version and allows comments. */
  let token: string;
  let linkId: string;

  /** A context with one artifact of one version, published by `member`, and `token`'s link. */
  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    const first = await publishFiles(ctx, member.user, { 'index.html': '<p>một</p>' });
    artifactId = first.artifact.id;
    v1 = first.version;
    clock.advance(1000);
    ({ token, linkId } = await share());
  }

  beforeEach(() => start());
  afterEach(() => ctx.close());

  /** A share link of the artifact; by default public, following the current version, open to comments. */
  async function share(o: Partial<LinkOptions> = {}) {
    const { row, token } = await createShareLink(ctx.deps, member.user, artifactId, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: true,
      ...o,
    });
    return { linkId: row.id, token };
  }

  /** A second version of the artifact, published by `member`. */
  async function publishV2(): Promise<VersionRow> {
    clock.advance(1000);
    const second = await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>hai</p>' },
      { kind: 'new_version', artifactId, expectedVersionId: v1.id },
    );
    clock.advance(1000);
    return second.version;
  }

  const newThread = (over: Partial<GuestThreadRequest> = {}): GuestThreadRequest => ({
    guest_name: 'Lan',
    body: 'Đẹp quá',
    anchor: sampleAnchor(),
    ...over,
  });

  const newReply = (over: Partial<GuestReplyRequest> = {}): GuestReplyRequest => ({
    guest_name: 'Lan',
    body: 'Đồng ý',
    ...over,
  });

  const base = (tok: string) => `/api/v1/share/${tok}/comments`;

  /** POSTs a new thread as a guest, with no cookie unless `o` gives one. */
  const guestPost = (tok: string, body: unknown, o: RequestOptions = {}) =>
    ctx.request(base(tok), apiInit(ctx, { method: 'POST', body, ...o }));

  const guestReply = (tok: string, id: string, body: unknown, o: RequestOptions = {}) =>
    ctx.request(`${base(tok)}/${id}/replies`, apiInit(ctx, { method: 'POST', body, ...o }));

  /** Sends `guestToken`, when given, in its header. */
  const withToken = (guestToken: string | undefined) =>
    guestToken === undefined ? {} : { headers: { [GUEST_TOKEN_HEADER]: guestToken } };

  const guestPatch = (tok: string, id: string, body: unknown, guestToken?: string) =>
    ctx.request(
      `${base(tok)}/${id}`,
      apiInit(ctx, { method: 'PATCH', body, ...withToken(guestToken) }),
    );

  const guestDelete = (tok: string, id: string, guestToken?: string) =>
    ctx.request(`${base(tok)}/${id}`, apiInit(ctx, { method: 'DELETE', ...withToken(guestToken) }));

  const guestList = (tok: string, query = '', cookie?: string) =>
    ctx.request(`${base(tok)}${query}`, apiInit(ctx, cookie === undefined ? {} : { cookie }));

  async function created(r: Response): Promise<GuestCreated> {
    expect(r.status, await r.clone().text()).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    return GuestCreated.parse(await r.json());
  }

  async function listed(tok: string, query = '', cookie?: string): Promise<CommentThreadList> {
    const r = await guestList(tok, query, cookie);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    return CommentThreadList.parse(await r.json());
  }

  async function errorOf(r: Response) {
    return { status: r.status, ...((await r.json()) as ErrorJson).error };
  }

  const commentRow = (id: string) =>
    ctx.deps.db.db.selectFrom('comments').selectAll().where('id', '=', id).executeTakeFirst();

  const guestWindowRefusal = {
    status: 403,
    code: 'forbidden',
    message: t('comment.guestWindow'),
  };
  const notFound = { status: 404, code: 'not_found', message: t('comment.notFound') };

  test('guests comment through a link that allows it', async () => {
    const r = await guestPost(token, newThread({ guest_name: ' Lan ', body: ' Đẹp quá ' }));
    const b = await created(r);
    expect(b).toMatchObject({
      thread: {
        author: { type: 'guest', name: 'Lan' },
        version: { id: v1.id, number: 1 },
        status: 'open',
        body: 'Đẹp quá',
        anchor: sampleAnchor(),
        replies: [],
        created_at: clock.now(),
        edited_at: null,
      },
      comment_id: b.thread.id,
      guest_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(await commentRow(b.comment_id)).toMatchObject({
      share_link_id: linkId,
      author_user_id: null,
      guest_name: 'Lan',
    });

    // Only the token's hash is kept, for the edit window.
    const key = `guest-comment:${hashSecret(b.guest_token)}`;
    expect(await ctx.deps.oneTime.peek(key)).toEqual({
      comment_id: b.comment_id,
      share_link_id: linkId,
    });
    expect(await ctx.deps.oneTime.peek(`guest-comment:${b.guest_token}`)).toBeNull();

    // Members see it like any other thread, and so do the link's viewers.
    const members = await restClient(ctx, member.cookie).get(`/artifacts/${artifactId}/comments`);
    expect(CommentThreadList.parse(members.body).items).toEqual([b.thread]);
    expect((await listed(token)).items).toEqual([b.thread]);
  });

  test('a link without comments refuses the comment routes', async () => {
    const thread = await postThread(ctx, member.cookie, artifactId);
    const closed = await share({ allowComments: false });
    const refused = { status: 403, code: 'forbidden', message: t('share.commentsOff') };
    expect(await errorOf(await guestList(closed.token))).toMatchObject(refused);
    expect(await errorOf(await guestPost(closed.token, newThread()))).toMatchObject(refused);
    expect(await errorOf(await guestReply(closed.token, thread.id, newReply()))).toMatchObject(
      refused,
    );
    expect(
      await errorOf(await guestPatch(closed.token, thread.id, { body: 'x' }, 'x'.repeat(43))),
    ).toMatchObject(refused);
    expect(await errorOf(await guestDelete(closed.token, thread.id, 'x'.repeat(43)))).toMatchObject(
      refused,
    );
    expect(await ctx.deps.db.db.selectFrom('comments').select('id').execute()).toHaveLength(1);
  });

  test('a guest name is required', async () => {
    const thread = await postThread(ctx, member.cookie, artifactId);
    const { guest_name: _, ...nameless } = newThread();
    for (const body of [nameless, newThread({ guest_name: '   ' })]) {
      const r = await guestPost(token, body);
      expect(r.status).toBe(400);
      const issues = (await errorOf(r)).details?.issues as { path: string }[];
      expect(issues[0]?.path).toBe('guest_name');
    }
    expect((await guestReply(token, thread.id, { body: 'Đồng ý' })).status).toBe(400);
    expect((await guestReply(token, thread.id, newReply({ guest_name: '' }))).status).toBe(400);
    expect((await guestPost(token, newThread({ guest_name: 'g'.repeat(61) }))).status).toBe(400);
    // A name is one line of text, and nothing in a guest's text may break the database.
    for (const name of ['Lan\nAdmin', 'Lan\u0000', 'L\u0085an']) {
      expect((await guestPost(token, newThread({ guest_name: name }))).status).toBe(400);
    }
    expect((await guestPost(token, newThread({ body: 'Đẹp\u0000quá' }))).status).toBe(400);
    expect((await guestReply(token, thread.id, newReply({ body: '\u0000' }))).status).toBe(400);
    expect(await ctx.deps.db.db.selectFrom('comments').select('id').execute()).toHaveLength(1);
    // Line breaks are fine in the text itself.
    await created(await guestPost(token, newThread({ body: 'Một\nHai' })));
  });

  test('guests edit and delete their own comment for 15 minutes', async () => {
    const a = await created(await guestPost(token, newThread()));
    clock.advance(1000);
    const b = await created(await guestPost(token, newThread({ guest_name: 'Bình' })));
    clock.advance(59_000);

    const r = await guestPatch(token, a.comment_id, { body: ' Sửa lại ' }, a.guest_token);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const edited = Comment.parse(await r.json());
    expect(edited).toMatchObject({
      id: a.comment_id,
      body: 'Sửa lại',
      author: { type: 'guest', name: 'Lan' },
      created_at: a.thread.created_at,
      updated_at: clock.now(),
      edited_at: clock.now(),
    });
    expect(edited).not.toHaveProperty('replies');
    // The token stays good for further edits within the window.
    expect((await guestPatch(token, a.comment_id, { body: 'Lần hai' }, a.guest_token)).status).toBe(
      200,
    );

    for (const wrong of [undefined, b.guest_token, 'x'.repeat(43), '']) {
      expect(
        await errorOf(await guestPatch(token, a.comment_id, { body: 'Không' }, wrong)),
      ).toMatchObject(guestWindowRefusal);
      expect(await errorOf(await guestDelete(token, a.comment_id, wrong))).toMatchObject(
        guestWindowRefusal,
      );
    }
    // A token works only through the link it was written through.
    const other = await share();
    expect(
      await errorOf(await guestPatch(other.token, a.comment_id, { body: 'Không' }, a.guest_token)),
    ).toMatchObject(guestWindowRefusal);
    expect((await commentRow(a.comment_id))?.body).toBe('Lần hai');

    clock.advance(GUEST_EDIT_WINDOW_MS - 60_000 + 1);
    expect(
      await errorOf(await guestPatch(token, a.comment_id, { body: 'Muộn' }, a.guest_token)),
    ).toMatchObject(guestWindowRefusal);
    expect(await errorOf(await guestDelete(token, a.comment_id, a.guest_token))).toMatchObject(
      guestWindowRefusal,
    );
    expect(await commentRow(a.comment_id)).toBeDefined();

    const fresh = await created(await guestPost(token, newThread()));
    const deleted = await guestDelete(token, fresh.comment_id, fresh.guest_token);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(await commentRow(fresh.comment_id)).toBeUndefined();
    expect(
      await ctx.deps.oneTime.peek(`guest-comment:${hashSecret(fresh.guest_token)}`),
    ).toBeNull();
    expect(
      await errorOf(await guestDelete(token, fresh.comment_id, fresh.guest_token)),
    ).toMatchObject(notFound);
    expect((await listed(token)).items.map((th) => th.id)).toEqual([a.comment_id, b.comment_id]);
  });

  test('guests cannot change member comments or resolve', async () => {
    const thread = await postThread(ctx, member.cookie, artifactId, { body: 'Sửa giá' });
    const g = await created(await guestPost(token, newThread()));
    for (const guestToken of [undefined, g.guest_token]) {
      expect(
        await errorOf(await guestPatch(token, thread.id, { body: 'Đổi' }, guestToken)),
      ).toMatchObject(guestWindowRefusal);
      expect(await errorOf(await guestDelete(token, thread.id, guestToken))).toMatchObject(
        guestWindowRefusal,
      );
    }
    for (const action of ['resolve', 'reopen']) {
      const r = await ctx.request(
        `${base(token)}/${thread.id}/${action}`,
        apiInit(ctx, { method: 'POST', body: {}, ...withToken(g.guest_token) }),
      );
      expect(r.status).toBe(404);
    }
    expect(await commentRow(thread.id)).toMatchObject({ body: 'Sửa giá', status: 'open' });
  });

  test('guest replies get their own token', async () => {
    const thread = await postThread(ctx, member.cookie, artifactId);
    const g = await created(await guestPost(token, newThread()));
    clock.advance(1000);

    const r = await created(await guestReply(token, thread.id, newReply({ guest_name: ' Bình ' })));
    expect(r.thread.id).toBe(thread.id);
    expect(r.thread.replies).toHaveLength(1);
    expect(r.thread.replies[0]).toMatchObject({
      id: r.comment_id,
      thread_id: thread.id,
      author: { type: 'guest', name: 'Bình' },
      body: 'Đồng ý',
      version: { number: 1 },
    });
    expect(r.guest_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.guest_token).not.toBe(g.guest_token);
    expect(await commentRow(r.comment_id)).toMatchObject({
      parent_id: thread.id,
      share_link_id: linkId,
      author_user_id: null,
      guest_name: 'Bình',
    });

    // Replying to a reply joins the same thread.
    clock.advance(1000);
    const nested = await created(await guestReply(token, r.comment_id, newReply()));
    expect(nested.thread.id).toBe(thread.id);
    expect(nested.thread.replies.map((c) => c.id)).toEqual([r.comment_id, nested.comment_id]);

    // The reply's token edits the reply only.
    expect((await guestPatch(token, r.comment_id, { body: 'Đã sửa' }, r.guest_token)).status).toBe(
      200,
    );
    expect(
      await errorOf(await guestPatch(token, thread.id, { body: 'x' }, r.guest_token)),
    ).toMatchObject(guestWindowRefusal);
    expect(
      await errorOf(await guestPatch(token, g.comment_id, { body: 'x' }, r.guest_token)),
    ).toMatchObject(guestWindowRefusal);
    expect(
      await errorOf(await guestPatch(token, r.comment_id, { body: 'x' }, g.guest_token)),
    ).toMatchObject(guestWindowRefusal);
    expect((await guestDelete(token, r.comment_id, r.guest_token)).status).toBe(204);
    const listedThread = (await listed(token)).items.find((th) => th.id === thread.id);
    expect(listedThread?.replies.map((c) => c.id)).toEqual([nested.comment_id]);

    expect(await errorOf(await guestReply(token, 'cmt_nope', newReply()))).toMatchObject(notFound);
  });

  test('share viewers see threads up to the version the link shows', async () => {
    const v2 = await publishV2();
    const t1 = await postThread(ctx, member.cookie, artifactId, { versionId: v1.id });
    clock.advance(1000);
    const t2 = await postThread(ctx, member.cookie, artifactId, { versionId: v2.id });
    clock.advance(1000);
    const g2 = await created(await guestPost(token, newThread()));
    clock.advance(1000);
    expect(g2.thread.version).toEqual({ id: v2.id, number: 2 });

    const pinned = await share({ versionId: v1.id });
    expect((await listed(pinned.token)).items.map((th) => th.id)).toEqual([t1.id]);
    // A thread from the per-version link is written on the version it shows.
    const g1 = await created(await guestPost(pinned.token, newThread()));
    expect(g1.thread.version).toEqual({ id: v1.id, number: 1 });
    expect((await listed(pinned.token)).items.map((th) => th.id)).toEqual([t1.id, g1.comment_id]);

    // Comments on newer versions do not exist as far as the per-version link goes.
    expect(await errorOf(await guestReply(pinned.token, t2.id, newReply()))).toMatchObject(
      notFound,
    );
    expect(
      await errorOf(await guestPatch(pinned.token, g2.comment_id, { body: 'x' }, g2.guest_token)),
    ).toMatchObject(notFound);
    expect(
      await errorOf(await guestDelete(pinned.token, g2.comment_id, g2.guest_token)),
    ).toMatchObject(notFound);
    expect(await commentRow(g2.comment_id)).toBeDefined();

    expect((await listed(token)).items.map((th) => th.id)).toEqual([
      t1.id,
      t2.id,
      g2.comment_id,
      g1.comment_id,
    ]);

    // Nor do comments of another artifact.
    const other = await publishFiles(ctx, member.user, { 'index.html': '<p>khác</p>' });
    const foreign = await postThread(ctx, member.cookie, other.artifact.id);
    expect(await errorOf(await guestReply(token, foreign.id, newReply()))).toMatchObject(notFound);
    expect(await errorOf(await guestDelete(token, foreign.id, 'x'.repeat(43)))).toMatchObject(
      notFound,
    );
    expect((await listed(token)).items).toHaveLength(4);
  });

  test('share viewers see names, never account ids or emails', async () => {
    // A name the IdP filled in from the email shows as the part before the `@`.
    const mai = await createSignedInUser(ctx, { kind: 'oidc', name: 'Mai.Tran@Example.test' });
    const thread = await postThread(ctx, mai.cookie, artifactId, { versionId: v1.id });
    const replied = await restClient(ctx, member.cookie).post(`/comments/${thread.id}/replies`, {
      body: 'Đã sửa',
    });
    expect(replied.status).toBe(201);
    const v2 = await publishV2();
    const resolved = await restClient(ctx, member.cookie).post(`/comments/${thread.id}/resolve`, {
      version_id: v2.id,
    });
    expect(resolved.status).toBe(200);
    const pinned = await share({ versionId: v1.id });

    const secrets = [member.user.id, mai.user.id, member.user.email, mai.user.email, v2.id];
    const expectNoSecrets = (body: unknown) => {
      const json = JSON.stringify(body);
      for (const secret of secrets) expect(json).not.toContain(secret);
    };
    const members = { type: 'member', user_id: null };

    // A link on v1 knows the thread was resolved, not in which (newer) version.
    const [seen] = (await listed(pinned.token)).items;
    expect(seen).toMatchObject({
      id: thread.id,
      author: { ...members, name: 'Mai.Tran' },
      replies: [{ author: { ...members, name: 'Linh' }, body: 'Đã sửa' }],
      status: 'resolved',
      resolved_in_version: null,
      resolved_by: { user_id: null, name: 'Linh' },
      resolved_at: clock.now(),
    });
    expectNoSecrets(seen);

    // A guest's reply comes back with the thread, as redacted.
    const g = await created(await guestReply(pinned.token, thread.id, newReply()));
    expect(g.thread).toMatchObject({
      author: { ...members, name: 'Mai.Tran' },
      resolved_in_version: null,
      replies: [{ author: { ...members, name: 'Linh' } }, { author: { type: 'guest' } }],
    });
    expectNoSecrets(g);

    // A link that shows v2 also shows the version the thread was resolved in.
    const [current] = (await listed(token)).items;
    expect(current).toMatchObject({
      author: { ...members, name: 'Mai.Tran' },
      resolved_in_version: { id: v2.id, number: 2 },
      resolved_by: { user_id: null, name: 'Linh' },
    });
    expectNoSecrets({ ...current, resolved_in_version: null });

    // Members still see who is who.
    const own = await restClient(ctx, member.cookie).get(`/artifacts/${artifactId}/comments`);
    expect(CommentThreadList.parse(own.body).items[0]).toMatchObject({
      author: { type: 'member', user_id: mai.user.id, name: 'Mai.Tran@Example.test' },
      resolved_by: { user_id: member.user.id, name: 'Linh' },
    });
  });

  test('share viewers filter and page threads', async () => {
    const a = await postThread(ctx, member.cookie, artifactId);
    clock.advance(1000);
    const b = await created(await guestPost(token, newThread()));
    clock.advance(1000);
    const c = await postThread(ctx, member.cookie, artifactId);
    const resolved = await restClient(ctx, member.cookie).post(`/comments/${a.id}/resolve`, {});
    expect(resolved.status).toBe(200);

    expect((await listed(token, '?status=open')).items.map((th) => th.id)).toEqual([
      b.comment_id,
      c.id,
    ]);
    expect((await listed(token, '?status=resolved')).items.map((th) => th.id)).toEqual([a.id]);
    const page1 = await listed(token, '?limit=2');
    expect(page1.items.map((th) => th.id)).toEqual([a.id, b.comment_id]);
    const cursor = encodeURIComponent(page1.next_cursor ?? '');
    const page2 = await listed(token, `?limit=2&cursor=${cursor}`);
    expect(page2.items.map((th) => th.id)).toEqual([c.id]);
    expect(page2.next_cursor).toBeNull();
    for (const bad of ['?status=closed', '?limit=0', '?cursor=garbage']) {
      expect((await guestList(token, bad)).status).toBe(400);
    }
  });

  test('a locked link needs the unlock cookie', async () => {
    const thread = await postThread(ctx, member.cookie, artifactId);
    const locked = await share({ password: PW });
    const required = {
      status: 401,
      code: 'unauthorized',
      message: t('share.passwordRequired'),
      details: { password_required: true },
    };
    expect(await errorOf(await guestList(locked.token))).toMatchObject(required);
    expect(await errorOf(await guestPost(locked.token, newThread()))).toMatchObject(required);
    expect(await errorOf(await guestReply(locked.token, thread.id, newReply()))).toMatchObject(
      required,
    );
    expect(await errorOf(await guestDelete(locked.token, thread.id, 'x'.repeat(43)))).toMatchObject(
      required,
    );

    const unlocked = await ctx.request(
      `/api/v1/share/${locked.token}/unlock`,
      apiInit(ctx, { method: 'POST', body: { password: PW } }),
    );
    expect(unlocked.status).toBe(204);
    const cookie = unlocked.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    expect((await listed(locked.token, '', cookie)).items.map((th) => th.id)).toEqual([thread.id]);
    const g = await created(await guestPost(locked.token, newThread(), { cookie }));
    const patch = (cookieHeader?: string) =>
      ctx.request(
        `${base(locked.token)}/${g.comment_id}`,
        apiInit(ctx, {
          method: 'PATCH',
          body: { body: 'Sửa' },
          headers: { [GUEST_TOKEN_HEADER]: g.guest_token },
          ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
        }),
      );
    // The guest token alone does not open a locked link.
    expect(await errorOf(await patch())).toMatchObject(required);
    expect((await patch(cookie)).status).toBe(200);

    // The cookie of one link does not open another.
    const another = await share({ password: PW });
    expect((await guestList(another.token, '', cookie)).status).toBe(401);
  });

  test('a revoked or expired link ends guest comments', async () => {
    const g = await created(await guestPost(token, newThread()));
    const expiring = await share({ expiresAt: clock.now() + 1000 });
    const e = await created(await guestPost(expiring.token, newThread()));

    await revokeShareLink(ctx.deps, member.user, linkId);
    for (const r of [
      await guestList(token),
      await guestPost(token, newThread()),
      await guestPatch(token, g.comment_id, { body: 'x' }, g.guest_token),
      await guestDelete(token, g.comment_id, g.guest_token),
    ]) {
      expect(await errorOf(r)).toMatchObject({ status: 410, details: { reason: 'revoked' } });
    }
    clock.advance(1000);
    expect(
      await errorOf(await guestPatch(expiring.token, e.comment_id, { body: 'x' }, e.guest_token)),
    ).toMatchObject({ status: 410, details: { reason: 'expired' } });
    expect(await commentRow(g.comment_id)).toMatchObject({ body: 'Đẹp quá' });
  });

  test('guest writes are rate limited per IP and per link', async () => {
    const thread = await postThread(ctx, member.cookie, artifactId);
    for (let i = 0; i < 9; i++) await created(await guestPost(token, newThread()));
    await created(await guestReply(token, thread.id, newReply()));
    const limited = await guestPost(token, newThread());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(
      String(SHARE_RATES.guestComment.windowMs / 1000),
    );
    expect((await guestReply(token, thread.id, newReply())).status).toBe(429);
    // Reading is not limited, and another link takes comments from the same address.
    expect((await guestList(token)).status).toBe(200);
    const other = await share();
    await created(await guestPost(other.token, newThread()));
    clock.advance(SHARE_RATES.guestComment.windowMs);
    await created(await guestPost(token, newThread()));

    await ctx.close();
    await start({ PINWALL_TRUST_PROXY: 'true' });
    const from = (i: number) => ({ headers: { 'x-forwarded-for': `198.51.${i >> 8}.${i & 255}` } });
    for (let i = 0; i < 200; i++) await created(await guestPost(token, newThread(), from(i)));
    const flooded = await guestPost(token, newThread(), from(200));
    expect(flooded.status).toBe(429);
    expect(flooded.headers.get('retry-after')).toBe(
      String(SHARE_RATES.guestCommentLink.windowMs / 1000),
    );
    const other2 = await share();
    await created(await guestPost(other2.token, newThread(), from(200)));
  });

  test('guest edits and deletes are rate limited per address', async () => {
    const g = await created(await guestPost(token, newThread()));
    const { limit, windowMs } = SHARE_RATES.guestEdit;
    for (let i = 0; i < limit; i++) {
      expect(
        (await guestPatch(token, g.comment_id, { body: `Lần ${i}` }, g.guest_token)).status,
      ).toBe(200);
    }
    const limited = await guestPatch(token, g.comment_id, { body: 'Nữa' }, g.guest_token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(windowMs / 1000));
    expect((await guestDelete(token, g.comment_id, g.guest_token)).status).toBe(429);
    // New comments have their own limit.
    await created(await guestPost(token, newThread()));
  });

  test('guest writes publish live events', async () => {
    const seen: LiveEvent[] = [];
    ctx.deps.events.subscribe(ARTIFACT_TOPIC(artifactId), (e) => seen.push(LiveEvent.parse(e)));
    const g = await created(await guestPost(token, newThread()));
    const r = await created(
      await guestReply(token, g.comment_id, newReply({ guest_name: 'Bình' })),
    );
    expect((await guestPatch(token, r.comment_id, { body: 'Sửa' }, r.guest_token)).status).toBe(
      200,
    );
    expect((await guestDelete(token, g.comment_id, g.guest_token)).status).toBe(204);

    expect(seen.map((e) => e.type)).toEqual([
      'comment.created',
      'comment.created',
      'comment.updated',
      'comment.deleted',
    ]);
    expect(seen[0]).toMatchObject({
      artifact_id: artifactId,
      thread: { id: g.comment_id, author: { type: 'guest', name: 'Lan' } },
    });
    expect(seen[1]).toMatchObject({
      thread: { replies: [{ id: r.comment_id, author: { type: 'guest', name: 'Bình' } }] },
    });
    expect(seen[2]).toMatchObject({ thread: { replies: [{ body: 'Sửa' }] } });
    expect(seen[3]).toMatchObject({ comment_id: g.comment_id, thread: null });
  });

  test('cross-origin guest posts are refused', async () => {
    const g = await created(await guestPost(token, newThread()));
    const evil = { origin: 'https://evil.example' };
    expect((await guestPost(token, newThread(), evil)).status).toBe(403);
    expect((await guestReply(token, g.comment_id, newReply(), evil)).status).toBe(403);
    const patch = await ctx.request(
      `${base(token)}/${g.comment_id}`,
      apiInit(ctx, { method: 'PATCH', body: { body: 'x' }, ...evil, ...withToken(g.guest_token) }),
    );
    expect(patch.status).toBe(403);
    const del = await ctx.request(
      `${base(token)}/${g.comment_id}`,
      apiInit(ctx, { method: 'DELETE', ...evil, ...withToken(g.guest_token) }),
    );
    expect(del.status).toBe(403);
    expect(await ctx.deps.db.db.selectFrom('comments').select(['id', 'body']).execute()).toEqual([
      { id: g.comment_id, body: 'Đẹp quá' },
    ]);
  });

  test('the API document describes the guest comment routes', async () => {
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    };
    expect(Object.keys(doc.paths['/share/{token}/comments'] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(doc.paths['/share/{token}/comments/{id}/replies'] ?? {})).toEqual(['post']);
    const one = doc.paths['/share/{token}/comments/{id}'] ?? {};
    expect(Object.keys(one).sort()).toEqual(['delete', 'patch']);
    for (const method of ['patch', 'delete']) {
      expect(one[method]?.parameters).toContainEqual(
        expect.objectContaining({ name: GUEST_TOKEN_HEADER, in: 'header' }),
      );
    }
  });
});
