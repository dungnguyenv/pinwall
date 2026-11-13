import {
  AdminLookup,
  AdminShareLink,
  AdminShareLinkList,
  EndGrantsResult,
  UpdateAdminUserRequest,
} from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import {
  createGrant,
  EXPIRED_GRANT_RETENTION_MS,
  purgeExpiredGrants,
} from '../../src/content/grants.ts';
import { parseReportedUrl } from '../../src/domain/moderation.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret, newContentToken, newSecret } from '../../src/lib/ids.ts';
import { apiInit } from '../helpers/auth.ts';
import { CONTENT_ENV, fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { type Reply, restClient } from '../helpers/rest.ts';
import {
  MODES,
  type Person,
  type SpacesFixture,
  spacesFixture,
  T,
  UNKNOWN_IDS,
} from '../spaces/fixture.ts';
import { moderationContext } from './helpers.ts';

/** The URLs a look-up test pastes, for one fixture in one context. */
interface Urls {
  origin: string;
  /** The artifact p. */
  p: string;
  /** The token of pLink, which follows the current version of p. */
  pToken: string;
  /** A's own review grant on version 1 of p. */
  aGrantOnV1: string;
  /** Where the grant's file lives in this context, as `fetchContent` asks for it. */
  contentUrl: (token: string, path: string) => string;
}

const LOOKUPS: [string, (u: Urls) => string, AdminLookup['kind'], number][] = [
  ['a share URL', (u) => `${u.origin}/s/${u.pToken}`, 'share_link', 2],
  ['its Open original URL', (u) => `${u.origin}/s/${u.pToken}/original?x=1`, 'share_link', 2],
  ['an artifact link', (u) => `${u.origin}/a/${u.p}`, 'artifact', 2],
  ['a version raw link', (u) => `${u.origin}/a/${u.p}/v/1/raw`, 'artifact', 1],
  ['a content URL', (u) => `${u.contentUrl(u.aGrantOnV1, 'index.html')}#top`, 'content_grant', 1],
];

/** Where file `path` of grant `token` is served in `c`'s isolation mode: `fetchContent`'s form. */
function contentUrlIn(c: TestContext, token: string, path: string): string {
  const { isolation, publicOrigin } = c.deps.config;
  if (isolation.mode === 'single-domain') return `${publicOrigin}/c/${token}/${path}`;
  const { scheme, host, port } = isolation.contentOrigin;
  return `${scheme}://${token}.${host}${port === undefined ? '' : `:${port}`}/${path}`;
}

/** How an admin sees `who`. */
const personOf = (who: Person) => ({
  id: who.user.id,
  name: who.user.name ?? '',
  email: who.user.email,
});

/** Every key anywhere in `value`. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysIn(inner)]);
}

describe.each(dialects)('admin moderation on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    // `ctx` serves content under `/c/<token>/` on the app origin; `cd` on a host of its own.
    let ctx: TestContext;
    let cd: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, mode);
      cd = await moderationContext(dialect, mode, CONTENT_ENV);
    });
    // Tests delete and revoke, so each gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await ctx?.close();
      await cd?.close();
    });

    const api = (c: TestContext, who: Person) => restClient(c, who.cookie);

    /** Every link the admin list shows `who`, over as many pages of `limit` as it takes. */
    async function listAll(who: Person, limit = 200): Promise<AdminShareLink[]> {
      const items: AdminShareLink[] = [];
      let cursor: string | null = null;
      do {
        const r: Reply = await api(ctx, who).get(
          `/admin/share-links?limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`,
        );
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const list = AdminShareLinkList.parse(r.body);
        items.push(...list.items);
        cursor = list.next_cursor;
      } while (cursor !== null);
      return items;
    }

    /** Gives link `linkId` a token we know, as the fixture's links were made without one. */
    async function tokenOf(c: TestContext, linkId: string): Promise<string> {
      const token = newSecret();
      await c.deps.db.db
        .updateTable('share_links')
        .set({ token_hash: hashSecret(token) })
        .where('id', '=', linkId)
        .execute();
      return token;
    }

    /** What a look-up test pastes for `f`'s fixture in `c`. */
    async function urlsOf(c: TestContext, f: SpacesFixture): Promise<Urls> {
      const grant = await createGrant(c.deps, {
        versionId: f.ids.pV1,
        mode: 'review',
        user: f.people.A.user,
      });
      return {
        origin: c.deps.config.publicOrigin,
        p: f.ids.p,
        pToken: await tokenOf(c, f.ids.pLink),
        aGrantOnV1: grant.token,
        contentUrl: (token, path) => contentUrlIn(c, token, path),
      };
    }

    test('the share-link list shows every active link, with metadata only', async () => {
      const { A, X } = fx.people;
      const db = ctx.deps.db.db;
      const ended = await createLink(ctx, A, fx.ids.p);
      const expired = await createLink(ctx, A, fx.ids.q);
      await revokeShareLink(ctx.deps, A.user, ended);
      await db
        .updateTable('share_links')
        .set({ expires_at: T })
        .where('id', '=', expired)
        .execute();

      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const r: { status: number; body: unknown } = await api(ctx, X).get(
          `/admin/share-links?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
        );
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const list = AdminShareLinkList.parse(r.body);
        expect(list.items.length).toBeLessThanOrEqual(2);
        for (const item of list.items) {
          expect(Object.keys(item).sort()).toEqual(Object.keys(AdminShareLink.shape).sort());
        }
        // The first page of a list this long has a next page.
        if (pages.length === 0) expect(list.next_cursor).not.toBeNull();
        for (const key of ['token', 'url', 'token_hash', 'password_hash']) {
          expect(keysIn(r.body)).not.toContain(key);
        }
        pages.push(list.items.map((item) => item.id));
        cursor = list.next_cursor;
      } while (cursor !== null);

      const ids = pages.flat();
      expect(new Set(ids).size, 'a link on two pages').toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining([fx.ids.pLink, fx.ids.qLink, fx.ids.eLink]));
      expect(ids).not.toContain(ended);
      expect(ids).not.toContain(expired);

      // The same links whatever the page size, newest first, ties by id.
      const all = await listAll(X);
      expect(all.map((item) => item.id)).toEqual(ids);
      const keys = all.map((item) => `${item.created_at}:${item.id}`);
      expect(keys).toEqual([...keys].sort().reverse());
    });

    test('a listed link names its artifact, owner, maker and version', async () => {
      const { A, E, X } = fx.people;
      const items = await listAll(X);
      const of = (id: string) => items.find((item) => item.id === id);

      const link = of(fx.ids.pLink);
      expect(link).toMatchObject({
        artifact: { id: fx.ids.p },
        owner: personOf(A),
        created_by: personOf(A),
        version: null,
        has_password: false,
        allow_comments: true,
        created_at: T,
        expires_at: null,
        last_used_at: null,
      });
      // E publishes e into A's project: the owner is whose space holds it in personal mode, and
      // whoever published it in team mode.
      expect(of(fx.ids.eLink)).toMatchObject({
        artifact: { id: fx.ids.e },
        owner: mode === 'personal' ? personOf(A) : personOf(E),
        created_by: personOf(E),
      });
    });

    test('a per-version link, one with a password and one that expires show as such', async () => {
      const { A, X } = fx.people;
      const made = await createShareLink(ctx.deps, A.user, fx.ids.p, {
        versionId: fx.ids.pV1,
        password: 'a long enough password',
        expiresAt: T + 3_600_000,
        allowComments: false,
      });
      const item = (await listAll(X)).find((i) => i.id === made.row.id);
      expect(item).toMatchObject({
        version: { id: fx.ids.pV1, number: 1 },
        has_password: true,
        allow_comments: false,
        expires_at: T + 3_600_000,
      });
    });

    test('an admin revokes a link: it answers gone and its grants end', async () => {
      const { X } = fx.people;
      const token = await tokenOf(ctx, fx.ids.pLink);
      const grant = await createGrant(ctx.deps, {
        versionId: fx.ids.pV2,
        mode: 'raw',
        user: null,
        shareLinkId: fx.ids.pLink,
      });
      expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(200);
      // The link allows comments, so it opens in the share viewer: its API answers.
      expect((await ctx.request(`/api/v1/share/${token}`, apiInit(ctx))).status).toBe(200);
      const published = vi.spyOn(ctx.deps.events, 'publish');
      const info = vi.spyOn(ctx.deps.logger, 'info');

      const r = await api(ctx, X).del(`/admin/share-links/${fx.ids.pLink}`);
      expect(r.status, JSON.stringify(r.body)).toBe(204);

      const gone = await ctx.request(`/s/${token}`, { redirect: 'manual' });
      expect(gone.status).toBe(410);
      expect(await gone.text()).toContain(t('share.gone.title'));
      expect((await ctx.request(`/api/v1/share/${token}`, apiInit(ctx))).status).toBe(410);
      expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(410);
      expect(published).toHaveBeenCalledWith(`share-link:${fx.ids.pLink}`, {
        type: 'share-link.revoked',
      });
      expect(info).toHaveBeenCalledWith(
        {
          admin_id: X.user.id,
          action: 'share_link.revoke',
          target: { share_link_id: fx.ids.pLink },
          outcome: 'done',
        },
        'moderation',
      );

      // The list no longer has it, and revoking it again changes nothing.
      expect((await listAll(X)).map((item) => item.id)).not.toContain(fx.ids.pLink);
      const before = await revokedAt(ctx, fx.ids.pLink);
      expect((await api(ctx, X).del(`/admin/share-links/${fx.ids.pLink}`)).status).toBe(204);
      expect(await revokedAt(ctx, fx.ids.pLink)).toBe(before);
    });

    test('revoking a link that does not exist answers 404, even for another space', async () => {
      const { X } = fx.people;
      const info = vi.spyOn(ctx.deps.logger, 'info');
      const r = await api(ctx, X).del(`/admin/share-links/${UNKNOWN_IDS.pLink}`);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: t('share.unknown') } });
      // A refused attempt is in the audit trail too.
      expect(info).toHaveBeenCalledWith(
        {
          admin_id: X.user.id,
          action: 'share_link.revoke',
          target: { share_link_id: UNKNOWN_IDS.pLink },
          outcome: 'refused',
          status: 404,
          code: 'not_found',
        },
        'moderation',
      );
      // Not X's to see in personal mode, and still theirs to revoke.
      expect((await api(ctx, X).del(`/admin/share-links/${fx.ids.qLink}`)).status).toBe(204);
    });

    test.each(LOOKUPS)(
      'look-up of %s names the artifact, its owner and the version',
      async (_name, url, kind, number) => {
        const { A, X } = fx.people;
        const u = await urlsOf(ctx, fx);
        const info = vi.spyOn(ctx.deps.logger, 'info');

        const r = await api(ctx, X).post('/admin/lookup', { url: url(u) });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const found = AdminLookup.parse(r.body);

        expect(found.kind).toBe(kind);
        expect(found.artifact).toEqual({
          id: fx.ids.p,
          name: expect.any(String),
          project: { id: fx.ids.P, name: 'P' },
          owner: personOf(A),
        });
        expect(found.version).toEqual({
          id: number === 2 ? fx.ids.pV2 : fx.ids.pV1,
          number,
          published_by: personOf(A),
        });
        expect(found.share_link?.id ?? null).toBe(kind === 'share_link' ? fx.ids.pLink : null);
        if (kind === 'content_grant') {
          expect(found.grant).toEqual({
            mode: 'review',
            expires_at: expect.any(Number),
            holder: personOf(A),
          });
        } else {
          expect(found.grant).toBeNull();
        }

        // Logged as its kind and the artifact, never as the URL or its token.
        expect(info).toHaveBeenCalledWith(
          {
            admin_id: X.user.id,
            action: 'lookup',
            target: kind === 'artifact' ? { kind, artifact_id: fx.ids.p } : { kind },
            outcome: 'done',
            result: { artifact_id: fx.ids.p },
          },
          'moderation',
        );
        const logged = JSON.stringify(info.mock.calls);
        for (const secret of [u.pToken, u.aGrantOnV1]) expect(logged).not.toContain(secret);
      },
    );

    test('look-up of a content URL works where content has a host of its own', async () => {
      const f = await spacesFixture(cd);
      const u = await urlsOf(cd, f);
      const url = u.contentUrl(u.aGrantOnV1, 'index.html');
      expect(url).toBe(`https://${u.aGrantOnV1}.pw-content.test/index.html`);

      const r = await api(cd, f.people.X).post('/admin/lookup', { url });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const found = AdminLookup.parse(r.body);
      expect(found).toMatchObject({
        kind: 'content_grant',
        artifact: { id: f.ids.p },
        version: { id: f.ids.pV1, number: 1 },
        share_link: null,
        grant: { mode: 'review', holder: personOf(f.people.A) },
      });
      // The share and artifact links keep working on the app's own origin.
      const share = await api(cd, f.people.X).post('/admin/lookup', {
        url: `${u.origin}/s/${u.pToken}`,
      });
      expect(AdminLookup.parse(share.body).kind).toBe('share_link');
      // A single-domain content URL is not one of this Pinwall's here.
      const single = await api(cd, f.people.X).post('/admin/lookup', {
        url: `${u.origin}/c/${u.aGrantOnV1}/index.html`,
      });
      expect(single.status).toBe(404);
    });

    test('look-up names who a content URL belongs to for 30 days after its grant expired', async () => {
      // A context of its own: the clock moves by a month, past every session.
      const own = await moderationContext(dialect, mode);
      try {
        const f = await spacesFixture(own);
        const { A, X } = f.people;
        const clock = own.deps.clock as FixedClock;
        /** X's look-up, by API token, as an admin who signed in again today. */
        const lookup = async (url: string) => {
          await own.deps.db.db
            .updateTable('users')
            .set({ idp_checked_at: clock.now() })
            .where('id', '=', X.user.id)
            .execute();
          const res = await own.request(
            '/api/v1/admin/lookup',
            apiInit(own, { bearer: X.token, body: { url } }),
          );
          return { status: res.status, body: (await res.json()) as unknown };
        };
        const grant = await createGrant(own.deps, {
          versionId: f.ids.pV1,
          mode: 'raw',
          user: A.user,
          ttlMs: 60_000,
        });
        const url = contentUrlIn(own, grant.token, 'index.html');

        // Expired a moment short of the retention: still refused, still kept, still named.
        clock.set(grant.expires_at + EXPIRED_GRANT_RETENTION_MS - 1);
        expect(await purgeExpiredGrants(own.deps)).toBe(0);
        const served = await fetchContent(own, grant.token, 'index.html');
        expect(served.status).toBe(410);
        expect(await served.text()).toContain(t('content.expired.message'));
        const kept = await lookup(url);
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        expect(AdminLookup.parse(kept.body)).toEqual({
          kind: 'content_grant',
          artifact: {
            id: f.ids.p,
            name: expect.any(String),
            project: { id: f.ids.P, name: 'P' },
            owner: personOf(A),
          },
          version: { id: f.ids.pV1, number: 1, published_by: personOf(A) },
          share_link: null,
          grant: { mode: 'raw', expires_at: grant.expires_at, holder: personOf(A) },
        });

        // Once the retention is over, the hourly purge deletes it: nothing to name any more.
        clock.advance(1);
        expect(await purgeExpiredGrants(own.deps)).toBe(1);
        expect(await lookup(url)).toEqual({
          status: 404,
          body: { error: { code: 'not_found', message: t('moderation.lookup.unknown') } },
        });
        expect((await fetchContent(own, grant.token, 'index.html')).status).toBe(404);
      } finally {
        await own.close();
      }
    });

    test('an expired grant whose content was revoked or deleted names no one', async () => {
      const { A, X } = fx.people;
      const clock = ctx.deps.clock as FixedClock;
      const expired = async (versionId: string, shareLinkId: string | null = null) => {
        const grant = await createGrant(ctx.deps, {
          versionId,
          mode: 'raw',
          user: shareLinkId === null ? A.user : null,
          shareLinkId,
          ttlMs: 1,
        });
        return contentUrlIn(ctx, grant.token, 'index.html');
      };
      const fromLink = await expired(fx.ids.pV2, fx.ids.pLink);
      const onQ = await expired(fx.ids.qV2);
      clock.advance(1);
      try {
        expect((await api(ctx, X).del(`/admin/share-links/${fx.ids.pLink}`)).status).toBe(204);
        expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.q}`)).status).toBe(204);
        for (const url of [fromLink, onQ]) {
          const r = await api(ctx, X).post('/admin/lookup', { url });
          expect({ url, status: r.status, keys: keysIn(r.body) }).toEqual({
            url,
            status: 404,
            keys: ['error', 'code', 'message'],
          });
        }
      } finally {
        clock.set(T);
      }
    });

    test("a share link's grant is looked up with the link it was made from, and no holder", async () => {
      const { X } = fx.people;
      const grant = await createGrant(ctx.deps, {
        versionId: fx.ids.pV2,
        mode: 'raw',
        user: null,
        shareLinkId: fx.ids.pLink,
      });
      const r = await api(ctx, X).post('/admin/lookup', {
        url: contentUrlIn(ctx, grant.token, 'index.html'),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const found = AdminLookup.parse(r.body);
      expect(found.kind).toBe('content_grant');
      expect(found.share_link).toMatchObject({ id: fx.ids.pLink, artifact: { id: fx.ids.p } });
      expect(found.grant).toEqual({ mode: 'raw', expires_at: grant.expires_at, holder: null });
      expect(found.version).toMatchObject({ id: fx.ids.pV2, number: 2 });
    });

    test('look-up still names a link that was revoked, so its artifact can be dealt with', async () => {
      const { X } = fx.people;
      const token = await tokenOf(ctx, fx.ids.pLink);
      await api(ctx, X).del(`/admin/share-links/${fx.ids.pLink}`);
      const r = await api(ctx, X).post('/admin/lookup', {
        url: `${ctx.deps.config.publicOrigin}/s/${token}`,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(AdminLookup.parse(r.body)).toMatchObject({
        kind: 'share_link',
        artifact: { id: fx.ids.p },
        share_link: { id: fx.ids.pLink },
      });
    });

    test('look-up of a per-version link names the link and its version', async () => {
      const { A, X } = fx.people;
      const made = await createShareLink(ctx.deps, A.user, fx.ids.p, {
        versionId: fx.ids.pV1,
        password: null,
        expiresAt: null,
        allowComments: false,
      });
      const r = await api(ctx, X).post('/admin/lookup', {
        url: `${ctx.deps.config.publicOrigin}/s/${made.token}/`,
      });
      const found = AdminLookup.parse(r.body);
      expect(found.version).toMatchObject({ id: fx.ids.pV1, number: 1 });
      expect(found.share_link).toMatchObject({
        id: made.row.id,
        version: { id: fx.ids.pV1, number: 1 },
      });
    });

    test("the owner of an artifact is its space's in personal mode and its publisher's in team mode", async () => {
      const { A, E, X } = fx.people;
      const r = await api(ctx, X).post('/admin/lookup', {
        url: `${ctx.deps.config.publicOrigin}/a/${fx.ids.e}`,
      });
      const found = AdminLookup.parse(r.body);
      expect(found.artifact.owner).toEqual(personOf(mode === 'personal' ? A : E));
      expect(found.version.published_by).toEqual(personOf(E));
    });

    test('look-up answers 404 for another site and unknown tokens, 410 for what was taken down, 400 for no URL', async () => {
      const { X } = fx.people;
      const u = await urlsOf(ctx, fx);
      const qToken = await tokenOf(ctx, fx.ids.qLink);
      const unknownShare = newSecret();
      const unknownGrant = newContentToken();
      const info = vi.spyOn(ctx.deps.logger, 'info');
      const lines: unknown[] = [];
      /** Looks `url` up, and checks the refusal was logged with `target`, never the address. */
      const lookup = async (url: string, target: object, status: number, code: string) => {
        info.mockClear();
        const r = await api(ctx, X).post('/admin/lookup', { url });
        expect(info, url).toHaveBeenCalledWith(
          { admin_id: X.user.id, action: 'lookup', target, outcome: 'refused', status, code },
          'moderation',
        );
        lines.push(...info.mock.calls);
        return r;
      };
      const unknown = { error: { code: 'not_found', message: t('moderation.lookup.unknown') } };
      const goneBody = { error: { code: 'gone', message: t('moderation.lookup.gone') } };
      const none = { kind: null };
      const share = { kind: 'share_link' };
      const grant = { kind: 'content_grant' };
      const artifact = (id: string) => ({ kind: 'artifact', artifact_id: id });

      for (const [url, target] of [
        [`https://evil.example/s/${u.pToken}`, none],
        [`${u.origin}/s/${unknownShare}`, share],
        [`${u.origin}/a/${UNKNOWN_IDS.p}`, artifact(UNKNOWN_IDS.p)],
        [`${u.origin}/a/${fx.ids.p}/v/9`, artifact(fx.ids.p)],
        [`${u.origin}/c/${unknownGrant}/index.html`, grant],
        [`${u.origin}/settings`, none],
        [u.origin, none],
      ] as const) {
        const r = await lookup(url, target, 404, 'not_found');
        expect({ url, status: r.status, body: r.body }).toEqual({
          url,
          status: 404,
          body: unknown,
        });
      }

      // Taken down: the artifact, a version, and the links and grants that went with them.
      expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.q}`)).status).toBe(204);
      expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.p}/versions/1`)).status).toBe(204);
      for (const [url, target] of [
        [`${u.origin}/a/${fx.ids.q}`, artifact(fx.ids.q)],
        [`${u.origin}/a/${fx.ids.p}/v/1`, artifact(fx.ids.p)],
        [`${u.origin}/s/${qToken}`, share],
        [u.contentUrl(u.aGrantOnV1, 'index.html'), grant],
      ] as const) {
        const r = await lookup(url, target, 410, 'gone');
        expect({ url, status: r.status, body: r.body }).toEqual({
          url,
          status: 410,
          body: goneBody,
        });
      }
      for (const url of [
        'not a url',
        'pinwall.example/s/abc',
        'ftp://pinwall.example/a/x',
        '   ',
      ]) {
        const r = await lookup(url, none, 400, 'bad_request');
        expect({ url, status: r.status }).toEqual({ url, status: 400 });
        expect(r.body).toMatchObject({
          error: { code: 'bad_request', message: t('moderation.lookup.badUrl') },
        });
      }
      expect((await api(ctx, X).post('/admin/lookup', { url: '' })).status).toBe(400);
      // Not one address or token reached the log.
      const logged = JSON.stringify(lines);
      for (const secret of [u.pToken, qToken, unknownShare, unknownGrant, u.aGrantOnV1]) {
        expect(logged).not.toContain(secret);
      }
    });

    test('look-up of a link whose artifact was deleted answers 410', async () => {
      const { X } = fx.people;
      const token = await tokenOf(ctx, fx.ids.pLink);
      expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.p}`)).status).toBe(204);
      const r = await api(ctx, X).post('/admin/lookup', {
        url: `${ctx.deps.config.publicOrigin}/s/${token}`,
      });
      expect(r.status).toBe(410);
    });

    test('takedown reaches any space and is logged', async () => {
      const { A, X } = fx.people;
      const info = vi.spyOn(ctx.deps.logger, 'info');
      // In personal mode, q is not X's to see; either way X can take it down.
      const seen = await api(ctx, X).get(`/artifacts/${fx.ids.q}`);
      expect(seen.status).toBe(mode === 'personal' ? 404 : 200);

      const deleted = await api(ctx, X).del(`/admin/artifacts/${fx.ids.q}`);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
      expect((await api(ctx, A).get(`/artifacts/${fx.ids.q}`)).status).toBe(410);
      const line = (action: string, target: object, outcome: object) => [
        { admin_id: X.user.id, action, target, ...outcome },
        'moderation',
      ];
      const done = { outcome: 'done' };
      const refused = (status: number, code: string) => ({ outcome: 'refused', status, code });
      expect(info).toHaveBeenCalledWith(
        ...line('artifact.delete', { artifact_id: fx.ids.q }, done),
      );
      // Deleting it again, or what was never there: refused, and logged as such.
      expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.q}`)).status).toBe(410);
      expect(info).toHaveBeenCalledWith(
        ...line('artifact.delete', { artifact_id: fx.ids.q }, refused(410, 'gone')),
      );
      expect((await api(ctx, X).del(`/admin/artifacts/${UNKNOWN_IDS.q}`)).status).toBe(404);
      expect(info).toHaveBeenCalledWith(
        ...line('artifact.delete', { artifact_id: UNKNOWN_IDS.q }, refused(404, 'not_found')),
      );

      const version = await api(ctx, X).del(`/admin/artifacts/${fx.ids.p}/versions/1`);
      expect(version.status, JSON.stringify(version.body)).toBe(204);
      expect((await api(ctx, A).get(`/artifacts/${fx.ids.p}/versions/1`)).status).toBe(410);
      expect((await api(ctx, A).get(`/artifacts/${fx.ids.p}/versions/2`)).status).toBe(200);
      expect(info).toHaveBeenCalledWith(
        ...line('version.delete', { artifact_id: fx.ids.p, number: 1 }, done),
      );
      expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.p}/versions/1`)).status).toBe(410);
      expect(info).toHaveBeenCalledWith(
        ...line('version.delete', { artifact_id: fx.ids.p, number: 1 }, refused(410, 'gone')),
      );
      expect((await api(ctx, X).del(`/admin/artifacts/${fx.ids.p}/versions/0`)).status).toBe(400);

      const grant = await createGrant(ctx.deps, {
        versionId: fx.ids.pV2,
        mode: 'review',
        user: A.user,
      });
      expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(200);
      const ended = await api(ctx, X).post(`/admin/versions/${fx.ids.pV2}/end-grants`);
      expect(ended.status, JSON.stringify(ended.body)).toBe(200);
      const { grants } = EndGrantsResult.parse(ended.body);
      expect(grants).toBeGreaterThanOrEqual(1);
      expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(410);
      expect(info).toHaveBeenCalledWith(
        ...line('version.end_grants', { version_id: fx.ids.pV2 }, { ...done, result: { grants } }),
      );
      // The version and its artifact stay; only what was handed out ends.
      expect((await api(ctx, A).get(`/artifacts/${fx.ids.p}/versions/2`)).status).toBe(200);
      expect(
        EndGrantsResult.parse(
          (await api(ctx, X).post(`/admin/versions/${fx.ids.pV2}/end-grants`)).body,
        ),
      ).toEqual({ grants: 0 });
      const missing = await api(ctx, X).post(`/admin/versions/${UNKNOWN_IDS.pV2}/end-grants`);
      expect(missing.status).toBe(404);
      expect(info).toHaveBeenCalledWith(
        ...line('version.end_grants', { version_id: UNKNOWN_IDS.pV2 }, refused(404, 'not_found')),
      );
    });

    test('ending the grants of a version ends those of its share links too, and nothing else', async () => {
      const { A, X } = fx.people;
      const guest = await createGrant(ctx.deps, {
        versionId: fx.ids.pV2,
        mode: 'raw',
        user: null,
        shareLinkId: fx.ids.pLink,
      });
      const member = await createGrant(ctx.deps, {
        versionId: fx.ids.pV2,
        mode: 'review',
        user: A.user,
      });
      const other = await createGrant(ctx.deps, {
        versionId: fx.ids.pV1,
        mode: 'review',
        user: A.user,
      });
      const ended = await api(ctx, X).post(`/admin/versions/${fx.ids.pV2}/end-grants`);
      expect(EndGrantsResult.parse(ended.body)).toEqual({ grants: 2 });
      expect((await fetchContent(ctx, guest.token, 'index.html')).status).toBe(410);
      expect((await fetchContent(ctx, member.token, 'index.html')).status).toBe(410);
      expect((await fetchContent(ctx, other.token, 'index.html')).status).toBe(200);
      // The link itself still opens, and makes new grants.
      const token = await tokenOf(ctx, fx.ids.pLink);
      expect((await ctx.request(`/api/v1/share/${token}`, apiInit(ctx))).status).toBe(200);
    });

    test('members get 403 on every admin route', async () => {
      const { E } = fx.people;
      const as = api(ctx, E);
      const calls = [
        () => as.get('/admin/share-links'),
        () => as.del(`/admin/share-links/${fx.ids.eLink}`),
        () => as.post('/admin/lookup', { url: `${ctx.deps.config.publicOrigin}/a/${fx.ids.e}` }),
        () => as.del(`/admin/artifacts/${fx.ids.e}`),
        () => as.del(`/admin/artifacts/${fx.ids.e}/versions/1`),
        () => as.post(`/admin/versions/${fx.ids.pV2}/end-grants`),
      ];
      for (const call of calls) {
        const r = await call();
        expect(r.status).toBe(403);
        expect(r.body).toEqual({ error: { code: 'forbidden', message: t('auth.adminOnly') } });
      }
      // Nothing happened.
      expect((await as.get(`/artifacts/${fx.ids.e}`)).status).toBe(200);
      expect(await revokedAt(ctx, fx.ids.eLink)).toBeNull();
    });

    test('no admin route moves a space', async () => {
      const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
        paths: Record<string, unknown>;
      };
      const admin = Object.keys(doc.paths).filter((path) => path.startsWith('/admin'));
      expect(admin).toEqual(
        expect.arrayContaining([
          '/admin/share-links',
          '/admin/share-links/{id}',
          '/admin/lookup',
          '/admin/artifacts/{id}',
          '/admin/artifacts/{id}/versions/{n}',
          '/admin/versions/{id}/end-grants',
        ]),
      );
      for (const path of admin) expect(path).not.toMatch(/transfer|owner|move/i);
      expect(Object.keys(UpdateAdminUserRequest.shape).join()).not.toMatch(/owner|transfer/i);
    });
  });
});

/** `revoked_at` of link `id`. */
async function revokedAt(ctx: TestContext, id: string): Promise<number | null> {
  const row = await ctx.deps.db.db
    .selectFrom('share_links')
    .select('revoked_at')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.revoked_at;
}

/** A link by `maker` on the artifact that follows its current version, open to anyone. */
async function createLink(ctx: TestContext, maker: Person, artifactId: string): Promise<string> {
  const { row } = await createShareLink(ctx.deps, maker.user, artifactId, {
    versionId: null,
    password: null,
    expiresAt: null,
    allowComments: false,
  });
  return row.id;
}

describe('parseReportedUrl', () => {
  const single = loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
  const split = loadConfig(CONTENT_ENV);
  const share = newSecret();
  const grant = newContentToken();

  test('knows the share, artifact and content URLs of a single-domain Pinwall', () => {
    const o = 'https://pinwall.test';
    expect(share).toHaveLength(43);
    const cases: [string, ReturnType<typeof parseReportedUrl>][] = [
      [`${o}/s/${share}`, { kind: 'share', token: share }],
      [`${o}/s/${share}/`, { kind: 'share', token: share }],
      [`${o}/s/${share}/original?x=1#y`, { kind: 'share', token: share }],
      [`${o}/a/art_abc`, { kind: 'artifact', id: 'art_abc', n: null }],
      [`${o}/a/art_abc/`, { kind: 'artifact', id: 'art_abc', n: null }],
      [`${o}/a/art_abc/raw`, { kind: 'artifact', id: 'art_abc', n: null }],
      [`${o}/a/art_abc/compare?from=1&to=2`, { kind: 'artifact', id: 'art_abc', n: null }],
      [`${o}/a/art_abc/v/3`, { kind: 'artifact', id: 'art_abc', n: 3 }],
      [`${o}/a/art_abc/v/3/raw#top`, { kind: 'artifact', id: 'art_abc', n: 3 }],
      [`${o}/a/art_abc/v/12/compare`, { kind: 'artifact', id: 'art_abc', n: 12 }],
      [`${o}/c/${grant}`, { kind: 'grant', token: grant }],
      [`${o}/c/${grant}/index.html?x#y`, { kind: 'grant', token: grant }],
      [`${o}/c/${grant}/a/b/c.png`, { kind: 'grant', token: grant }],
    ];
    for (const [url, expected] of cases)
      expect(parseReportedUrl(single, url), url).toEqual(expected);
  });

  test('knows a content host of a Pinwall with content domains, and not a /c/ path', () => {
    const o = 'https://pinwall.test';
    expect(parseReportedUrl(split, `https://${grant}.pw-content.test/index.html?x#y`)).toEqual({
      kind: 'grant',
      token: grant,
    });
    expect(parseReportedUrl(split, `https://${grant}.pw-content.test`)).toEqual({
      kind: 'grant',
      token: grant,
    });
    expect(parseReportedUrl(split, `${o}/s/${share}`)).toEqual({ kind: 'share', token: share });
    expect(parseReportedUrl(split, `${o}/a/art_abc/v/1`)).toEqual({
      kind: 'artifact',
      id: 'art_abc',
      n: 1,
    });
    expect(parseReportedUrl(split, `${o}/c/${grant}/index.html`)).toBeNull();
    // Where content has no host of its own, a host is not a grant.
    expect(parseReportedUrl(single, `https://${grant}.pw-content.test/index.html`)).toBeNull();
  });

  test('knows nothing else: another site, scheme, port or shape', () => {
    const o = 'https://pinwall.test';
    for (const url of [
      `https://evil.example/s/${share}`,
      `https://evil.example/a/art_abc`,
      `http://pinwall.test/s/${share}`,
      `https://pinwall.test:8443/s/${share}`,
      `https://pinwall.test.evil.example/s/${share}`,
      `https://sub.pinwall.test/s/${share}`,
      `${o}/s/${share.slice(1)}`,
      `${o}/s/${share}x`,
      `${o}/s/${share}/other`,
      `${o}/s/`,
      `${o}/a/`,
      `${o}/a/art_abc/v/x`,
      `${o}/a/art_abc/v/`,
      `${o}/a/art_abc/v/3/files`,
      `${o}/a/art_abc/other`,
      `${o}/a//v/1`,
      `${o}/c/${grant.slice(1)}/x`,
      `${o}/c/${grant.toUpperCase()}/x`,
      `${o}/c/`,
      `${o}/`,
      o,
      'mailto:a@pinwall.test',
      'not a url',
      '',
    ]) {
      expect(parseReportedUrl(single, url), url).toBeNull();
    }
    for (const url of [
      `http://${grant}.pw-content.test/`,
      `https://${grant}.pw-content.test:8443/`,
      `https://x.${grant}.pw-content.test/`,
      `https://${grant}.evil.test/`,
      `https://${grant}.pw-content.test.evil.test/`,
      `https://${grant.slice(1)}.pw-content.test/`,
      `https://pw-content.test/`,
      `https://www.pw-content.test/`,
    ]) {
      expect(parseReportedUrl(split, url), url).toBeNull();
    }
  });

  test('treats a port as part of the origin', () => {
    const local = loadConfig({ PINWALL_PUBLIC_ORIGIN: 'http://localhost:8080' });
    expect(parseReportedUrl(local, `http://localhost:8080/a/art_abc`)).toEqual({
      kind: 'artifact',
      id: 'art_abc',
      n: null,
    });
    expect(parseReportedUrl(local, `http://localhost/a/art_abc`)).toBeNull();
    expect(parseReportedUrl(local, `http://localhost:9090/a/art_abc`)).toBeNull();
  });
});
