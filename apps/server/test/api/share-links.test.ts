import { CreatedShareLink, ShareLinkList } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createGrant } from '../../src/content/grants.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { listShareLinks } from '../../src/domain/shares.ts';
import { addTombstones, isTombstoned } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

type Member = { user: UserRow; cookie: string };

describe.each(dialects)('share links on %s', (dialect) => {
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

  /** POSTs a new link of the artifact as `m`. */
  function create(body: unknown): Promise<Response> {
    return ctx.request(
      `/api/v1/artifacts/${id}/share-links`,
      apiInit(ctx, { method: 'POST', cookie: m.cookie, body }),
    );
  }

  /** Creates a link as `who`, one second after whatever came before. */
  async function made(who: Member = m, body: Record<string, unknown> = {}) {
    clock.advance(1000);
    const r = await api(who).post(`/artifacts/${id}/share-links`, body);
    expect(r.status).toBe(201);
    return CreatedShareLink.parse(r.body);
  }

  /** The artifact's links as `m` sees them. */
  async function list(q = '') {
    const r = await ctx.request(
      `/api/v1/artifacts/${id}/share-links${q}`,
      apiInit(ctx, { cookie: m.cookie }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    return ShareLinkList.parse(await r.json());
  }

  async function errorOf(r: Response | Promise<Response>) {
    const res = await r;
    return { status: res.status, message: ((await res.json()) as ErrorJson).error.message };
  }

  test('a member creates a link and sees its token once', async () => {
    const r = await create({});
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { token: string; url: string; link: { id: string } };
    expect(body).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      link: {
        version: null,
        has_password: false,
        allow_comments: false,
        expires_at: null,
        status: 'active',
        created_by: { user_id: m.user.id },
        revoked_at: null,
      },
    });
    expect(CreatedShareLink.parse(body).link).toEqual({
      id: body.link.id,
      artifact_id: id,
      version: null,
      has_password: false,
      allow_comments: false,
      expires_at: null,
      created_by: { user_id: m.user.id, name: 'Minh' },
      created_at: clock.now(),
      last_used_at: null,
      revoked_at: null,
      status: 'active',
    });
    expect(body.link.id).toMatch(/^shr_/);
    expect(body.url).toBe(`http://localhost:8080/s/${body.token}`);

    const row = await ctx.deps.db.db
      .selectFrom('share_links')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(hashSecret(body.token));
    expect(Object.values(row)).not.toContain(body.token);

    const listed = await list();
    expect(listed.items).toEqual([body.link]);
    expect(listed.items[0]).not.toHaveProperty('token');
    expect(JSON.stringify(listed)).not.toContain(body.token);
  });

  test('per-version links, passwords and expiry are validated', async () => {
    const perVersion = CreatedShareLink.parse(await (await create({ version_id: v1.id })).json());
    expect(perVersion.link.version).toEqual({ id: v1.id, number: 1 });
    const following = CreatedShareLink.parse(await (await create({ version_id: null })).json());
    expect(following.link.version).toBeNull();

    const other = await publishFiles(ctx, pub.user, { 'index.html': '<p>khác</p>' });
    expect(await errorOf(create({ version_id: other.version.id }))).toEqual({
      status: 400,
      message: t('version.notInArtifact'),
    });
    expect((await create({ version_id: 'ver_nope' })).status).toBe(400);

    expect(await errorOf(create({ password: 'seven77' }))).toEqual({
      status: 400,
      message: t('share.passwordTooShort', { min: 8 }),
    });
    expect(await errorOf(create({ password: 'p'.repeat(257) }))).toEqual({
      status: 400,
      message: t('share.passwordTooLong', { max: 256 }),
    });
    expect((await create({ password: '' })).status).toBe(400);
    const locked = CreatedShareLink.parse(
      await (await create({ password: 'Mật khẩu 1', allow_comments: true })).json(),
    );
    expect(locked.link).toMatchObject({ has_password: true, allow_comments: true });
    const stored = await ctx.deps.db.db
      .selectFrom('share_links')
      .select(['password_hash', 'allow_comments'])
      .where('id', '=', locked.link.id)
      .executeTakeFirstOrThrow();
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain('Mật khẩu');
    expect(stored.allow_comments).toBe(1);
    const open = await ctx.deps.db.db
      .selectFrom('share_links')
      .select('password_hash')
      .where('id', '=', following.link.id)
      .executeTakeFirstOrThrow();
    expect(open.password_hash).toBeNull();

    expect(await errorOf(create({ expires_at: clock.now() }))).toEqual({
      status: 400,
      message: t('share.badExpiry'),
    });
    expect((await create({ expires_at: clock.now() - 1 })).status).toBe(400);
    const expiring = await create({ expires_at: clock.now() + 1 });
    expect(expiring.status).toBe(201);
    expect(CreatedShareLink.parse(await expiring.json()).link).toMatchObject({
      expires_at: clock.now() + 1,
      status: 'active',
    });

    for (const bad of [{ allow_comments: 'yes' }, { expires_at: 1.5 }, { password: 7 }]) {
      expect((await create(bad)).status).toBe(400);
    }
    const links = await ctx.deps.db.db.selectFrom('share_links').select('id').execute();
    expect(links).toHaveLength(4);
  });

  test('the creator, the publisher or an admin can revoke', async () => {
    const first = await made(m);
    const refused = await api(o).del(`/share-links/${first.link.id}`);
    expect(refused.status).toBe(403);
    expect((refused.body as ErrorJson).error.message).toBe(t('share.revokeForbidden'));
    expect((await list()).items[0]?.status).toBe('active');

    clock.advance(1000);
    const revoked = await api(pub).del(`/share-links/${first.link.id}`);
    expect(revoked.status).toBe(204);
    expect(revoked.body).toBeNull();
    const revokedAt = clock.now();
    clock.advance(1000);
    expect((await api(pub).del(`/share-links/${first.link.id}`)).status).toBe(204);
    expect((await list()).items).toEqual([]);
    const all = await list('?include_revoked=true');
    expect(all.items).toEqual([{ ...first.link, status: 'revoked', revoked_at: revokedAt }]);
    // Still forbidden to others once revoked.
    expect((await api(o).del(`/share-links/${first.link.id}`)).status).toBe(403);

    const second = await made(o);
    expect((await api(m).del(`/share-links/${second.link.id}`)).status).toBe(403);
    expect((await api(o).del(`/share-links/${second.link.id}`)).status).toBe(204);
    const third = await made(m);
    expect((await api(admin).del(`/share-links/${third.link.id}`)).status).toBe(204);
    expect((await list('?include_revoked=1')).items.map((l) => l.status)).toEqual([
      'revoked',
      'revoked',
      'revoked',
    ]);

    const unknown = await api(m).del('/share-links/shr_unknown');
    expect(unknown.status).toBe(404);
    expect((unknown.body as ErrorJson).error.message).toBe(t('share.unknown'));
  });

  test('revoking ends the content grants made from the link at once', async () => {
    const { link } = await made(m);
    const kept = await made(m);
    const grant = await createGrant(ctx.deps, {
      versionId: v2.id,
      mode: 'raw',
      user: null,
      shareLinkId: link.id,
    });
    const other = await createGrant(ctx.deps, {
      versionId: v2.id,
      mode: 'raw',
      user: null,
      shareLinkId: kept.link.id,
    });
    const member = await createGrant(ctx.deps, { versionId: v2.id, mode: 'raw', user: m.user });
    const served = await fetchContent(ctx, grant.token, 'index.html');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('<p>hai</p>');

    expect((await api(m).del(`/share-links/${link.id}`)).status).toBe(204);
    const r = await fetchContent(ctx, grant.token, 'index.html');
    expect(r.status).toBe(410);
    expect(await r.text()).toContain(t('content.gone.title'));
    const db = ctx.deps.db.db;
    expect(
      await db
        .selectFrom('content_grants')
        .select('token')
        .where('token', '=', grant.token)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await isTombstoned(db, 'content_grant', grant.token, clock.now())).toBe(true);
    const tomb = await db
      .selectFrom('tombstones')
      .selectAll()
      .where('kind', '=', 'content_grant')
      .where('key', '=', grant.token)
      .executeTakeFirstOrThrow();
    expect(tomb.expires_at).toBe(grant.expires_at);

    // Grants of other links and of members serve on.
    expect((await fetchContent(ctx, other.token, 'index.html')).status).toBe(200);
    expect((await fetchContent(ctx, member.token, 'index.html')).status).toBe(200);
  });

  test('status reports expiry', async () => {
    const r = await create({ expires_at: clock.now() + 1000 });
    expect(r.status).toBe(201);
    const { link } = CreatedShareLink.parse(await r.json());
    expect(link.status).toBe('active');
    clock.advance(999);
    expect((await list()).items[0]?.status).toBe('active');
    clock.advance(1);
    expect((await list()).items[0]?.status).toBe('expired');
    clock.advance(1);
    expect((await list()).items[0]).toMatchObject({ status: 'expired', revoked_at: null });

    // A revoked link reads revoked, expired or not.
    expect((await api(m).del(`/share-links/${link.id}`)).status).toBe(204);
    expect((await list('?include_revoked=true')).items[0]?.status).toBe('revoked');
  });

  test('links list newest first, a page at a time', async () => {
    const a = await made(m);
    const b = await made(o, { version_id: v1.id });
    const c = await made(pub);
    // Two links made at the same moment order by id.
    const d = await made(m);
    const e = CreatedShareLink.parse((await api(m).post(`/artifacts/${id}/share-links`, {})).body);
    const sameMoment = [d.link.id, e.link.id].sort().reverse();
    expect((await api(o).del(`/share-links/${b.link.id}`)).status).toBe(204);

    expect((await list()).items.map((l) => l.id)).toEqual([...sameMoment, c.link.id, a.link.id]);
    const everything = [...sameMoment, c.link.id, b.link.id, a.link.id];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string =
        cursor === null
          ? '?include_revoked=true&limit=2'
          : `?include_revoked=true&limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await list(q);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((l) => l.id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(everything);

    for (const bad of ['?cursor=garbage', '?limit=0', '?limit=201', '?include_revoked=maybe']) {
      expect((await api(m).get(`/artifacts/${id}/share-links${bad}`)).status, bad).toBe(400);
    }
  });

  test('a creator whose account is gone shows as an unknown member', async () => {
    const { link } = await made(m);
    await ctx.deps.db.db.updateTable('share_links').set({ created_by: null }).execute();
    expect((await list()).items).toEqual([{ ...link, created_by: { user_id: null, name: null } }]);
    // Only the publisher or an admin can revoke it now.
    expect((await api(m).del(`/share-links/${link.id}`)).status).toBe(403);
    expect((await api(pub).del(`/share-links/${link.id}`)).status).toBe(204);
  });

  test('a page of links costs the same queries whatever its size', async () => {
    // Every page has a per-version link: the newest one is.
    for (let i = 0; i < 6; i++) {
      await made(i % 2 === 0 ? m : o, i % 2 === 1 ? { version_id: v1.id } : {});
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
      const { items } = await listShareLinks(deps, id, {
        includeRevoked: false,
        limit,
        cursor: null,
      });
      expect(items).toHaveLength(limit);
      return seen;
    };
    const one = await queries(1);
    expect(one).toBeGreaterThan(0);
    expect(await queries(6)).toBe(one);
  });

  test('share links need a member', async () => {
    const { link } = await made(m);
    expect((await ctx.request(`/api/v1/artifacts/${id}/share-links`)).status).toBe(401);
    const anonymous = await ctx.request(
      `/api/v1/artifacts/${id}/share-links`,
      apiInit(ctx, { body: {} }),
    );
    expect(anonymous.status).toBe(401);
    const anonymousRevoke = await ctx.request(
      `/api/v1/share-links/${link.id}`,
      apiInit(ctx, { method: 'DELETE' }),
    );
    expect(anonymousRevoke.status).toBe(401);
    expect(await ctx.deps.db.db.selectFrom('share_links').select('id').execute()).toHaveLength(1);
    expect((await list()).items[0]?.status).toBe('active');
  });

  test('links of a missing or deleted artifact answer 404 or 410', async () => {
    const unknown = await api(m).get('/artifacts/art_nope/share-links');
    expect(unknown.status).toBe(404);
    expect((unknown.body as ErrorJson).error.message).toBe(t('artifact.notFound'));
    expect((await api(m).post('/artifacts/art_nope/share-links', {})).status).toBe(404);

    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: id, expiresAt: null }],
      clock.now(),
    );
    await ctx.deps.db.db.deleteFrom('artifacts').where('id', '=', id).execute();
    const listed = await api(m).get(`/artifacts/${id}/share-links`);
    expect(listed.status).toBe(410);
    expect((listed.body as ErrorJson).error.message).toBe(t('artifact.gone'));
    expect((await api(m).post(`/artifacts/${id}/share-links`, {})).status).toBe(410);
  });

  test('the API document describes the share link routes', async () => {
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.paths['/artifacts/{id}/share-links'] ?? {}).sort()).toEqual([
      'get',
      'post',
    ]);
    expect(Object.keys(doc.paths['/share-links/{id}'] ?? {})).toEqual(['delete']);
  });
});
