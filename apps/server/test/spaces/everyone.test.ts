import type { Project, ProjectList, ProjectMemberList, PublicConfig } from '@pinwall/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { idpAccessCurrent, MAX_IDP_STALENESS_MS } from '../../src/auth/oidc/gate.ts';
import { effectiveRole, hasAccess, type Role } from '../../src/auth/roles.ts';
import { createGrant, resolveGrant } from '../../src/content/grants.ts';
import type { DbDialect } from '../../src/db/connect.ts';
import type { RoleOverride, UserKind } from '../../src/db/schema.ts';
import type { AppDeps } from '../../src/deps.ts';
import { mayExpose } from '../../src/domain/exposure.ts';
import { getProject } from '../../src/domain/projects.ts';
import { defaultProjectFor, SYSTEM_SCOPE, scopeForUser } from '../../src/domain/spaces.ts';
import { transferContent } from '../../src/domain/transfer.ts';
import { t } from '../../src/lib/i18n.ts';
import { newId } from '../../src/lib/ids.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { type ErrorJson, type Reply, restClient } from '../helpers/rest.ts';
import { sampleAnchor } from '../helpers/review.ts';
import {
  type Person,
  type SpacesFixture,
  spacesContext,
  spacesFixture,
  T,
  UNKNOWN_IDS,
} from './fixture.ts';

const EVERYONE_ON = { PINWALL_EVERYONE_PROJECTS: 'true' };

function expectStatus(r: Reply, status: number) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

const makeVisible = (on: boolean) => ({ visible_to_everyone: on });

/** The same deps with `PINWALL_EVERYONE_PROJECTS` set to `on`. */
const withEveryone = (deps: AppDeps, on: boolean): AppDeps => ({
  ...deps,
  config: { ...deps.config, everyoneProjects: on },
});

/** Whether `person` sees project `id` through the domain, in `deps`'s configuration. */
async function sees(deps: AppDeps, person: Person, id: string): Promise<boolean> {
  try {
    await getProject(deps.db.db, scopeForUser(deps, person.user), id);
    return true;
  } catch {
    return false;
  }
}

describe.each(dialects)('projects visible to everyone on %s', (dialect: DbDialect) => {
  describe('with PINWALL_EVERYONE_PROJECTS off (the default)', () => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'personal');
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    test('a project cannot be made visible to everyone, and nothing says it could', async () => {
      const { A } = fx.people;
      const asA = restClient(ctx, A.cookie);
      const refused = await asA.patch<ErrorJson>(`/projects/${fx.ids.P}`, makeVisible(true));
      expectStatus(refused, 400);
      expect(refused.body).toEqual({
        error: {
          code: 'bad_request',
          message: t('project.everyoneOff'),
          details: { field: 'visible_to_everyone' },
        },
      });

      const config = await asA.get<PublicConfig>('/config/public');
      expect(config.body.everyone_projects).toBeUndefined();

      const read = await asA.get<Project>(`/projects/${fx.ids.P}`);
      expect(read.body).toMatchObject({ visible_to_everyone: false, everyone_can_view: false });
      // Keeping it private is always allowed.
      expectStatus(await asA.patch(`/projects/${fx.ids.P}`, makeVisible(false)), 200);
    });

    test('a project marked before the setting was turned off stays hidden', async () => {
      const { S } = fx.people;
      await ctx.deps.db.db
        .updateTable('projects')
        .set({ visible_to_everyone: 1 })
        .where('id', '=', fx.ids.Q)
        .execute();
      const r = await restClient(ctx, S.cookie).get<ErrorJson>(`/projects/${fx.ids.Q}`);
      expectStatus(r, 404);
      const unknown = await restClient(ctx, S.cookie).get<ErrorJson>(`/projects/${UNKNOWN_IDS.Q}`);
      expect(r.body).toEqual(unknown.body);
    });
  });

  describe('with PINWALL_EVERYONE_PROJECTS on', () => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'personal', EVERYONE_ON);
      fx = await spacesFixture(ctx);
      const { A } = fx.people;
      const made = await restClient(ctx, A.cookie).patch<Project>(
        `/projects/${fx.ids.P}`,
        makeVisible(true),
      );
      expectStatus(made, 200);
    });
    afterAll(() => ctx?.close());

    test('the public configuration says owners may', async () => {
      const r = await restClient(ctx, fx.people.S.cookie).get<PublicConfig>('/config/public');
      expect(r.body.everyone_projects).toBe(true);
    });

    test('the owner sees their choice and that it is in effect; others see only the effect', async () => {
      const { A, S, E } = fx.people;
      const own = await restClient(ctx, A.cookie).get<Project>(`/projects/${fx.ids.P}`);
      expect(own.body).toMatchObject({
        role: 'owner',
        visible_to_everyone: true,
        everyone_can_view: true,
      });
      const other = await restClient(ctx, A.cookie).get<Project>(`/projects/${fx.ids.Q}`);
      expect(other.body).toMatchObject({ visible_to_everyone: false, everyone_can_view: false });

      const stranger = await restClient(ctx, S.cookie).get<Project>(`/projects/${fx.ids.P}`);
      expectStatus(stranger, 200);
      expect(stranger.body).toMatchObject({
        role: 'viewer',
        everyone_can_view: true,
        owner: { id: A.user.id },
      });
      expect(stranger.body).not.toHaveProperty('visible_to_everyone');

      // A member keeps their own role.
      const editor = await restClient(ctx, E.cookie).get<Project>(`/projects/${fx.ids.P}`);
      expect(editor.body).toMatchObject({ role: 'editor', everyone_can_view: true });
    });

    test('everyone else finds it in their projects and its artifacts in theirs and in search', async () => {
      const { S, X } = fx.people;
      for (const person of [S, X]) {
        const api = restClient(ctx, person.cookie);
        const projects = await api.get<ProjectList>('/projects');
        const ids = projects.body.items.map((project) => project.id);
        expect(ids).toContain(fx.ids.P);
        expect(ids).not.toContain(fx.ids.Q);

        const artifacts = await api.get<{ items: { id: string }[] }>('/artifacts');
        const artifactIds = artifacts.body.items.map((artifact) => artifact.id);
        expect(artifactIds).toEqual(expect.arrayContaining([fx.ids.p, fx.ids.e]));
        expect(artifactIds).not.toContain(fx.ids.q);

        const filtered = await api.get(`/artifacts?project_id=${fx.ids.P}`);
        expectStatus(filtered, 200);
        expectStatus(await api.get(`/artifacts/${fx.ids.q}`), 404);
      }
    });

    test('everyone else views and comments, and nothing more', async () => {
      const { S, A } = fx.people;
      const api = restClient(ctx, S.cookie);
      for (const path of [
        `/artifacts/${fx.ids.p}`,
        `/artifacts/${fx.ids.p}/versions`,
        `/artifacts/${fx.ids.p}/versions/2/files`,
        `/artifacts/${fx.ids.p}/comments`,
        `/artifacts/${fx.ids.p}/diff?from=1&to=2`,
        `/artifacts/${fx.ids.p}/versions/2/preview?mode=review`,
      ]) {
        expectStatus(await api.get(path), 200);
      }
      const thread = await api.post(`/artifacts/${fx.ids.p}/comments`, {
        body: 'Seen by everyone',
        anchor: sampleAnchor(),
      });
      expectStatus(thread, 201);

      const role = (r: Reply<ErrorJson>) => {
        expectStatus(r, 403);
        expect(r.body.error.details).toMatchObject({ reason: 'role' });
      };
      role(await api.post(`/artifacts/${fx.ids.p}/share-links`, {}));
      role(await api.patch(`/projects/${fx.ids.P}`, { name: 'Mine now' }));
      role(await api.patch(`/projects/${fx.ids.P}`, makeVisible(false)));
      role(await api.patch(`/artifacts/${fx.ids.p}`, { name: 'Mine now' }));
      role(
        await api.post('/publish/inline', {
          target: { project_id: fx.ids.P },
          files: [{ path: 'index.html', content: '<p>Inline</p>' }],
        }),
      );
      role(
        await api.post(`/projects/${fx.ids.P}/members`, {
          email: 'x@example.test',
          role: 'viewer',
        }),
      );

      // The members are listed, without their emails; there is no membership to leave.
      const members = await api.get<ProjectMemberList>(`/projects/${fx.ids.P}/members`);
      expectStatus(members, 200);
      expect(members.body.items.every((member) => member.user.email === null)).toBe(true);
      expect(members.body.items.map((member) => member.user.id)).not.toContain(S.user.id);
      expectStatus(await api.del(`/projects/${fx.ids.P}/members/${S.user.id}`), 404);

      // The owner still sees them all, with their emails.
      const ownersView = await restClient(ctx, A.cookie).get<ProjectMemberList>(
        `/projects/${fx.ids.P}/members`,
      );
      expect(ownersView.body.items.every((member) => member.user.email !== null)).toBe(true);
    });

    test('only the owner changes it', async () => {
      const { E, V } = fx.people;
      for (const person of [E, V]) {
        const r = await restClient(ctx, person.cookie).patch<ErrorJson>(
          `/projects/${fx.ids.P}`,
          makeVisible(false),
        );
        expectStatus(r, 403);
        expect(r.body.error.details).toMatchObject({ reason: 'role' });
      }
    });

    test('a default project cannot be visible to everyone', async () => {
      const { A } = fx.people;
      const own = await defaultProjectFor(ctx.deps, scopeForUser(ctx.deps, A.user));
      const r = await restClient(ctx, A.cookie).patch<ErrorJson>(
        `/projects/${own.id}`,
        makeVisible(true),
      );
      expectStatus(r, 409);
      expect(r.body.error).toMatchObject({
        code: 'conflict',
        message: t('project.everyoneDefault'),
      });

      // Nor does one count if it was marked anyway.
      await ctx.deps.db.db
        .updateTable('projects')
        .set({ visible_to_everyone: 1 })
        .where('id', '=', own.id)
        .execute();
      expect(await sees(ctx.deps, fx.people.S, own.id)).toBe(false);
      await ctx.deps.db.db
        .updateTable('projects')
        .set({ visible_to_everyone: 0 })
        .where('id', '=', own.id)
        .execute();
    });

    test('making it private again ends everyone else’s access at once, review pages included', async () => {
      const local = await spacesFixture(ctx);
      const { A, S, V } = local.people;
      const asA = restClient(ctx, A.cookie);
      expectStatus(await asA.patch(`/projects/${local.ids.P}`, makeVisible(true)), 200);
      const grant = await createGrant(ctx.deps, {
        versionId: local.ids.pV2,
        mode: 'review',
        user: S.user,
      });
      await expect(resolveGrant(ctx.deps, grant.token)).resolves.toMatchObject({
        version: { id: local.ids.pV2 },
      });

      expectStatus(await asA.patch(`/projects/${local.ids.P}`, makeVisible(false)), 200);
      const gone = await restClient(ctx, S.cookie).get<ErrorJson>(`/projects/${local.ids.P}`);
      const unknown = await restClient(ctx, S.cookie).get<ErrorJson>(`/projects/${UNKNOWN_IDS.P}`);
      expectStatus(gone, 404);
      expect(gone.body).toEqual(unknown.body);
      await expect(resolveGrant(ctx.deps, grant.token)).rejects.toMatchObject({ status: 410 });
      // Members are not touched.
      expect(await sees(ctx.deps, V, local.ids.P)).toBe(true);
    });

    test('turning the setting off hides those projects, and turning it on brings them back', async () => {
      const { S } = fx.people;
      expect(await sees(withEveryone(ctx.deps, false), S, fx.ids.P)).toBe(false);
      expect(await sees(withEveryone(ctx.deps, true), S, fx.ids.P)).toBe(true);
    });

    test('an owner who is blocked or disabled no longer shows their projects to everyone', async () => {
      const local = await spacesFixture(ctx);
      const { A, S } = local.people;
      expectStatus(
        await restClient(ctx, A.cookie).patch(`/projects/${local.ids.P}`, makeVisible(true)),
        200,
      );
      expect(await sees(ctx.deps, S, local.ids.P)).toBe(true);
      const { db } = ctx.deps.db;
      await db
        .updateTable('users')
        .set({ role_override: 'blocked' })
        .where('id', '=', A.user.id)
        .execute();
      expect(await sees(ctx.deps, S, local.ids.P)).toBe(false);
      await db
        .updateTable('users')
        .set({ role_override: null, disabled_at: T })
        .where('id', '=', A.user.id)
        .execute();
      expect(await sees(ctx.deps, S, local.ids.P)).toBe(false);
      await db
        .updateTable('users')
        .set({ disabled_at: null })
        .where('id', '=', A.user.id)
        .execute();
      expect(await sees(ctx.deps, S, local.ids.P)).toBe(true);
    });
  });

  describe('with PINWALL_EVERYONE_PROJECTS on and share links needing approval', () => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'personal', {
        ...EVERYONE_ON,
        PINWALL_SHARE_LINKS: 'approved',
      });
      // The fixture makes share links as people nobody approved, as before the switch.
      const { config } = ctx.deps;
      fx = await spacesFixture({
        ...ctx,
        deps: { ...ctx.deps, config: { ...config, shareLinks: 'members' } },
      });
    });
    afterAll(() => ctx?.close());

    const approve = (person: Person, approved: boolean) =>
      ctx.deps.db.db
        .updateTable('users')
        .set({ share_approved: approved ? 1 : 0 })
        .where('id', '=', person.user.id)
        .execute();

    test('only owners who may make share links make a project visible to everyone', async () => {
      const { A, S } = fx.people;
      const asA = restClient(ctx, A.cookie);
      const refused = await asA.patch<ErrorJson>(`/projects/${fx.ids.P}`, makeVisible(true));
      expectStatus(refused, 403);
      expect(refused.body.error).toEqual({
        code: 'forbidden',
        message: t('project.everyoneNotApproved'),
        details: { reason: 'share_links_not_approved' },
      });

      await approve(A, true);
      expectStatus(await asA.patch(`/projects/${fx.ids.P}`, makeVisible(true)), 200);
      expect(await sees(ctx.deps, S, fx.ids.P)).toBe(true);

      // Approval taken back: the choice stays, but it is not in effect until approved again.
      await approve(A, false);
      expect(await sees(ctx.deps, S, fx.ids.P)).toBe(false);
      const own = await asA.get<Project>(`/projects/${fx.ids.P}`);
      expect(own.body).toMatchObject({ visible_to_everyone: true, everyone_can_view: false });
      // Keeping it private needs no approval.
      expectStatus(await asA.patch(`/projects/${fx.ids.P}`, makeVisible(false)), 200);
      expectStatus(await asA.patch(`/projects/${fx.ids.P}`, makeVisible(true)), 403);

      await approve(A, true);
      expectStatus(await asA.patch(`/projects/${fx.ids.P}`, makeVisible(true)), 200);
      expect(await sees(ctx.deps, S, fx.ids.P)).toBe(true);
    });

    test('an admin needs no approval', async () => {
      const { X, S } = fx.people;
      const asX = restClient(ctx, X.cookie);
      const made = await asX.post<Project>('/projects', { name: 'For everyone' });
      expectStatus(made, 201);
      expectStatus(await asX.patch(`/projects/${made.body.id}`, makeVisible(true)), 200);
      expect(await sees(ctx.deps, S, made.body.id)).toBe(true);
    });
  });

  describe('in team mode', () => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'team', EVERYONE_ON);
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    test('the setting does nothing: everyone sees every project already', async () => {
      const { A } = fx.people;
      const api = restClient(ctx, A.cookie);
      expect(
        (await api.get<PublicConfig>('/config/public')).body.everyone_projects,
      ).toBeUndefined();
      expectStatus(await api.patch(`/projects/${fx.ids.P}`, makeVisible(true)), 400);
      const read = await api.get<Project>(`/projects/${fx.ids.P}`);
      expect(read.body).not.toHaveProperty('everyone_can_view');
      expect(read.body).not.toHaveProperty('visible_to_everyone');
    });
  });

  describe('the rule in SQL', () => {
    let ctx: TestContext;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'personal', EVERYONE_ON);
    });
    afterAll(() => ctx?.close());

    test('agrees with hasAccess, idpAccessCurrent and mayExpose for every kind of owner', async () => {
      const { db } = ctx.deps.db;
      const viewer = await spacesFixture(ctx);
      const { S } = viewer.people;
      const recheck = ctx.deps.config.access.recheckIntervalMs;
      type Owner = {
        kind: UserKind;
        idp_role: Role | null;
        role_override: RoleOverride | null;
        share_approved: 0 | 1;
        disabled_at: number | null;
        idp_checked_at: number | null;
        idp_refresh_token: string | null;
      };
      const owners: Owner[] = [];
      for (const share_approved of [0, 1] as const) {
        for (const disabled_at of [null, T]) {
          owners.push({
            kind: 'owner',
            idp_role: null,
            role_override: null,
            share_approved,
            disabled_at,
            idp_checked_at: null,
            idp_refresh_token: null,
          });
          for (const idp_role of [null, 'member', 'admin'] as const) {
            for (const role_override of [null, 'member', 'admin', 'blocked'] as const) {
              // Never checked; just now; past a re-check without a refresh token; past any bound.
              for (const idp_checked_at of [null, T, T - recheck - 1, T - MAX_IDP_STALENESS_MS]) {
                for (const idp_refresh_token of [null, 'refresh']) {
                  owners.push({
                    kind: 'oidc',
                    idp_role,
                    role_override,
                    share_approved,
                    disabled_at,
                    idp_checked_at,
                    idp_refresh_token,
                  });
                }
              }
            }
          }
        }
      }
      const cases: { id: string; projectId: string }[] = [];
      for (const owner of owners) {
        const id = newId('usr');
        const oidc = owner.kind === 'oidc';
        await db
          .insertInto('users')
          .values({
            id,
            name: id,
            email: null,
            email_verified: 0,
            oidc_issuer: oidc ? 'https://idp.example.test' : null,
            oidc_subject: oidc ? id : null,
            created_at: T,
            ...owner,
          })
          .execute();
        const projectId = newId('prj');
        await db
          .insertInto('projects')
          .values({
            id: projectId,
            name: id,
            instructions: '',
            is_default: 0,
            archived_at: null,
            owner_id: id,
            created_by: id,
            created_at: T,
            updated_at: T,
            visible_to_everyone: 1,
          })
          .execute();
        cases.push({ id, projectId });
      }
      for (const shareLinks of ['members', 'approved'] as const) {
        const deps = { ...ctx.deps, config: { ...ctx.deps.config, shareLinks } };
        for (const { id, projectId } of cases) {
          const owner = await db
            .selectFrom('users')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
          const expected =
            hasAccess(owner) &&
            idpAccessCurrent(owner, T, deps.config) &&
            mayExpose(deps.config, owner);
          const label = `${shareLinks}: ${owner.kind} idp=${owner.idp_role} override=${owner.role_override} approved=${owner.share_approved} disabled=${owner.disabled_at !== null} checked=${owner.idp_checked_at} refresh=${owner.idp_refresh_token !== null} (${effectiveRole(owner)})`;
          expect(await sees(deps, S, projectId), label).toBe(expected);
        }
      }
    });
  });

  describe('moving a space', () => {
    let ctx: TestContext;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'personal', EVERYONE_ON);
    });
    afterAll(() => ctx?.close());

    test('projects moved to someone else become private: the new owner never chose otherwise', async () => {
      const fx = await spacesFixture(ctx);
      const { A, V, S } = fx.people;
      expectStatus(
        await restClient(ctx, A.cookie).patch(`/projects/${fx.ids.P}`, makeVisible(true)),
        200,
      );
      expect(await sees(ctx.deps, S, fx.ids.P)).toBe(true);
      await transferContent(ctx.deps, SYSTEM_SCOPE, A.user, V.user);
      expect(await sees(ctx.deps, S, fx.ids.P)).toBe(false);
      const moved = await restClient(ctx, V.cookie).get<Project>(`/projects/${fx.ids.P}`);
      expect(moved.body).toMatchObject({ role: 'owner', visible_to_everyone: false });
    });
  });
});
