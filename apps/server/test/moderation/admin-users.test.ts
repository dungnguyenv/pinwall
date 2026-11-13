import { AdminUser, AdminUserList } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createShareLink } from '../../src/domain/shares.ts';
import { usageOf } from '../../src/domain/usage.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import { MODES, type Person, type SpacesFixture, spacesFixture, T } from '../spaces/fixture.ts';
import { approve, contextWith, moderationContext } from './helpers.ts';

describe.each(dialects)('admin users moderation on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    // `ctx` lets every member share, so the fixture can make its links; `ap` is the same
    // instance with PINWALL_SHARE_LINKS=approved.
    let ctx: TestContext;
    let ap: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, mode);
      ap = contextWith(ctx, { shareLinks: 'approved' });
    });
    // Tests approve people and revoke links, so each gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(() => ctx?.close());

    const patch = (c: TestContext, who: Person, id: string, body: unknown) =>
      restClient(c, who.cookie).patch(`/admin/users/${id}`, body);

    /** A link `maker` makes while everyone may share: no password, comments off. */
    function linkBy(maker: Person, artifactId: string) {
      return createShareLink(ctx.deps, maker.user, artifactId, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: false,
      });
    }

    /** The status of the page a share link's token opens through `c`. */
    async function opens(c: TestContext, token: string): Promise<number> {
      return (await c.request(`/s/${token}`, { redirect: 'manual' })).status;
    }

    /** How many links `person` made that are not revoked. */
    async function liveLinksOf(person: Person): Promise<number> {
      const rows = await ctx.deps.db.db
        .selectFrom('share_links')
        .select('id')
        .where('created_by', '=', person.user.id)
        .where('revoked_at', 'is', null)
        .execute();
      return rows.length;
    }

    test('the user list carries usage, approval and quota overrides in both modes', async () => {
      const { A, E, X } = fx.people;
      const r = await restClient(ctx, X.cookie).get('/admin/users?limit=200');
      expect(r.status).toBe(200);
      const items = AdminUserList.parse(r.body).items;
      const of = (who: Person) => items.find((item) => item.id === who.user.id);

      const a = of(A);
      expect(a).toBeDefined();
      const ownedByA = await ctx.deps.db.db
        .selectFrom('projects')
        .select('id')
        .where('owner_id', '=', A.user.id)
        .execute();
      const usedByA = await usageOf(ctx.deps.db.db, ctx.deps.config, A.user.id);
      expect(a?.usage).toEqual({
        projects: ownedByA.length,
        // Personal mode counts the space: p, q and E's e, which lives in P, and their versions.
        artifacts: mode === 'personal' ? 3 : 2,
        versions: mode === 'personal' ? 5 : 4,
        bytes: usedByA.bytes,
        share_links: 2,
        last_published_at: T,
      });
      expect(a?.usage?.projects).toBeGreaterThanOrEqual(2);
      expect(a?.usage?.bytes).toBeGreaterThan(0);
      expect(a).toMatchObject({ share_approved: false, quota_bytes: null, quota_artifacts: null });

      // E publishes one artifact into A's project and made one link: team mode counts it for E,
      // personal mode for A.
      expect(of(E)?.usage).toEqual({
        projects: 0,
        artifacts: mode === 'personal' ? 0 : 1,
        versions: mode === 'personal' ? 0 : 1,
        bytes:
          mode === 'personal'
            ? 0
            : (await usageOf(ctx.deps.db.db, ctx.deps.config, E.user.id)).bytes,
        share_links: 1,
        last_published_at: T,
      });
      // Someone who published nothing has nothing, and no last publish.
      expect(of(fx.people.S)?.usage).toEqual({
        projects: 0,
        artifacts: 0,
        versions: 0,
        bytes: 0,
        share_links: 0,
        last_published_at: null,
      });
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(Object.keys(AdminUser.shape).sort());
      }
    });

    test('the list counts only the share links that are still active', async () => {
      const { A, X } = fx.people;
      const sharesOf = async () => {
        const r = await restClient(ctx, X.cookie).get('/admin/users?limit=200');
        return AdminUserList.parse(r.body).items.find((u) => u.id === A.user.id)?.usage
          ?.share_links;
      };
      const setLink = (id: string, change: { revoked_at?: number; expires_at?: number }) =>
        ctx.deps.db.db.updateTable('share_links').set(change).where('id', '=', id).execute();
      expect(await sharesOf()).toBe(2);
      await setLink(fx.ids.qLink, { revoked_at: T });
      expect(await sharesOf()).toBe(1);
      // Expired links, like revoked ones, are no longer active.
      await setLink(fx.ids.pLink, { expires_at: T });
      expect(await sharesOf()).toBe(0);
    });

    test('PATCH sets approval and quota overrides and logs the change', async () => {
      const { E, X } = fx.people;
      const info = vi.spyOn(ctx.deps.logger, 'info');
      const r = await patch(ctx, X, E.user.id, {
        share_approved: true,
        quota_bytes: 1000,
        quota_artifacts: null,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(AdminUser.parse(r.body)).toMatchObject({
        id: E.user.id,
        share_approved: true,
        quota_bytes: 1000,
        quota_artifacts: null,
      });
      // The change asked for, and what it revoked.
      expect(info).toHaveBeenCalledWith(
        {
          admin_id: X.user.id,
          action: 'user.update',
          target: {
            user_id: E.user.id,
            changes: { share_approved: true, quota_bytes: 1000, quota_artifacts: null },
          },
          outcome: 'done',
          result: { share_links: 0 },
        },
        'moderation',
      );
      const row = await ctx.deps.db.db
        .selectFrom('users')
        .select(['share_approved', 'quota_bytes', 'quota_artifacts'])
        .where('id', '=', E.user.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ share_approved: 1, quota_bytes: 1000, quota_artifacts: null });

      // A key left out stays; null gives the instance's limit back; 0 is a limit of its own.
      const second = await patch(ctx, X, E.user.id, { quota_artifacts: 0, quota_bytes: null });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({
        share_approved: true,
        quota_bytes: null,
        quota_artifacts: 0,
      });
    });

    test('PATCH refuses an empty body, a negative or fractional quota, and members', async () => {
      const { E, S, X } = fx.people;
      expect((await patch(ctx, X, E.user.id, {})).status).toBe(400);
      expect((await patch(ctx, X, E.user.id, { quota_bytes: -1 })).status).toBe(400);
      expect((await patch(ctx, X, E.user.id, { quota_artifacts: 1.5 })).status).toBe(400);
      expect((await patch(ctx, X, E.user.id, { share_approved: 'yes' })).status).toBe(400);
      const denied = await patch(ctx, S, E.user.id, { share_approved: true });
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: { code: 'forbidden', message: t('auth.adminOnly') } });

      const info = vi.spyOn(ctx.deps.logger, 'info');
      const unknown = await patch(ctx, X, 'usr_nobody', { share_approved: true });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({
        error: { code: 'not_found', message: t('auth.userNotFound') },
      });
      expect(info).toHaveBeenCalledWith(
        {
          admin_id: X.user.id,
          action: 'user.update',
          target: { user_id: 'usr_nobody', changes: { share_approved: true } },
          outcome: 'refused',
          status: 404,
          code: 'not_found',
        },
        'moderation',
      );
    });

    test("removing approval revokes the person's links when links need approval", async () => {
      const { E, X } = fx.people;
      await approve(ctx, E.user.id);
      const link = await linkBy(E, fx.ids.e);
      expect(await opens(ap, link.token)).toBe(302);
      expect(await liveLinksOf(E)).toBe(2);

      const info = vi.spyOn(ctx.deps.logger, 'info');
      const r = await patch(ap, X, E.user.id, { share_approved: false });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ id: E.user.id, share_approved: false });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.update',
          outcome: 'done',
          result: { share_links: 2 },
        }),
        'moderation',
      );

      const gone = await ap.request(`/s/${link.token}`, { redirect: 'manual' });
      expect(gone.status).toBe(410);
      expect(await gone.text()).toContain(t('share.gone.title'));
      expect(await liveLinksOf(E)).toBe(0);
      const revoked = await ctx.deps.db.db
        .selectFrom('share_links')
        .select('revoked_at')
        .where('id', '=', link.row.id)
        .executeTakeFirstOrThrow();
      expect(revoked.revoked_at).toBe(T);
    });

    test('removing approval ends the streams of the links it revokes', async () => {
      const { E, X } = fx.people;
      await approve(ctx, E.user.id);
      const published = vi.spyOn(ap.deps.events, 'publish');
      await patch(ap, X, E.user.id, { share_approved: false });
      expect(published).toHaveBeenCalledWith(`share-link:${fx.ids.eLink}`, {
        type: 'share-link.revoked',
      });
    });

    test('with links open to members, removing approval revokes nothing', async () => {
      const { E, X } = fx.people;
      await approve(ctx, E.user.id);
      const link = await linkBy(E, fx.ids.e);
      const r = await patch(ctx, X, E.user.id, { share_approved: false });
      expect(r.status).toBe(200);
      expect(await opens(ctx, link.token)).toBe(302);
      expect(await liveLinksOf(E)).toBe(2);
    });

    test('an admin keeps their links when their own approval goes', async () => {
      const { X } = fx.people;
      const { artifact } = await publishFiles(ctx, X.user, { 'index.html': '<p>Own</p>' });
      const link = await linkBy(X, artifact.id);
      await approve(ctx, X.user.id);
      const r = await patch(ap, X, X.user.id, { share_approved: false });
      expect(r.status).toBe(200);
      expect(await opens(ap, link.token)).toBe(302);
    });

    test('the same approval again, or none in the patch, revokes nothing', async () => {
      const { E, X } = fx.people;
      // Never approved: nothing to remove.
      expect((await patch(ap, X, E.user.id, { share_approved: false })).status).toBe(200);
      expect(await liveLinksOf(E)).toBe(1);
      // Approved, and only a quota changes.
      await approve(ctx, E.user.id);
      expect((await patch(ap, X, E.user.id, { quota_bytes: 5 })).status).toBe(200);
      expect(await liveLinksOf(E)).toBe(1);
    });

    test('the admin routes need the admin, by session or token', async () => {
      const { E, X } = fx.people;
      const bearer = await ctx.request(
        `/api/v1/admin/users/${E.user.id}`,
        apiInit(ctx, { method: 'PATCH', body: { share_approved: true }, bearer: X.token }),
      );
      expect(bearer.status).toBe(200);
      const anonymous = await ctx.request(
        `/api/v1/admin/users/${E.user.id}`,
        apiInit(ctx, { method: 'PATCH', body: { share_approved: true } }),
      );
      expect(anonymous.status).toBe(401);
    });
  });
});
