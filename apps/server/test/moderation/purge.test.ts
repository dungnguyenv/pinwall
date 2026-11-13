import { PurgeResult } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { systemDeleteArtifact, systemDeleteVersion } from '../../src/domain/deletion.ts';
import { assertPurgeConfirmed, purgeSpace } from '../../src/domain/purge.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { t } from '../../src/lib/i18n.ts';
import { newId } from '../../src/lib/ids.ts';
import type { BlobStore } from '../../src/storage/index.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { referencedShas } from '../helpers/backup.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import { type Person, type SpacesFixture, spacesFixture } from '../spaces/fixture.ts';
import { moderationContext } from './helpers.ts';

describe.each(dialects)('purging a space on %s', (dialect) => {
  describe('in personal mode', () => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, 'personal');
    });
    // Purges delete, so each test gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(() => ctx?.close());

    const db = () => ctx.deps.db.db;

    const purge = (who: Person, id: string, confirm: string) =>
      restClient(ctx, who.cookie).post(`/admin/users/${id}/purge`, { confirm_email: confirm });

    /** The keys in the blob store, sorted as `referencedShas` sorts them. */
    async function storedBlobs(): Promise<string[]> {
      const keys: string[] = [];
      for await (const key of ctx.deps.blobs.list()) keys.push(key);
      return keys.sort();
    }

    const projectsOf = async (person: Person) =>
      (
        await db()
          .selectFrom('projects')
          .select('id')
          .where('owner_id', '=', person.user.id)
          .execute()
      )
        .map((row) => row.id)
        .sort();

    async function linkTo(person: Person, artifactId: string) {
      return createShareLink(ctx.deps, person.user, artifactId, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: false,
      });
    }

    test("admin purge deletes the person's projects and artifacts; links answer gone; the user stays", async () => {
      const { A, E, X } = fx.people;
      const owned = await projectsOf(A);
      const link = await linkTo(A, fx.ids.p);
      const info = vi.spyOn(ctx.deps.logger, 'info');

      const r = await purge(X, A.user.id, A.user.email?.toUpperCase() ?? '');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // p, q and E's e, which lives in P.
      expect(PurgeResult.parse(r.body)).toEqual({ projects: owned.length, artifacts: 3 });

      const page = await ctx.request(`/s/${link.token}`, { redirect: 'manual' });
      expect(page.status).toBe(410);
      expect(await page.text()).toContain(t('share.gone.title'));
      // E's own artifact went with P, and answers "gone" as any deleted artifact does.
      expect((await restClient(ctx, E.cookie).get(`/artifacts/${fx.ids.e}`)).status).toBe(410);
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));

      expect(await projectsOf(A)).toEqual([]);
      const rows = await db().selectFrom('artifacts').select('id').execute();
      expect(rows.map((row) => row.id)).not.toContain(fx.ids.p);
      const user = await db()
        .selectFrom('users')
        .select('id')
        .where('id', '=', A.user.id)
        .executeTakeFirst();
      expect(user).toBeDefined();
      expect(info).toHaveBeenCalledWith(
        { admin_id: X.user.id, action: 'user.purge', target: { user_id: A.user.id } },
        'moderation',
      );
    });

    /** A project of `person`'s own, with one artifact of a page nobody else has. */
    async function projectWithOneArtifact(
      person: Person,
    ): Promise<{ project: string; artifact: string }> {
      const made = await restClient(ctx, person.cookie).post<{ id: string }>('/projects', {
        name: 'Mine',
      });
      expect(made.status).toBe(201);
      const { artifact } = await publishFiles(
        ctx,
        person.user,
        { 'index.html': `<p>Mine ${Math.random()}</p>` },
        { kind: 'new_artifact', projectId: made.body.id, name: null, tags: [] },
      );
      return { project: made.body.id, artifact: artifact.id };
    }

    test("purge leaves other people's projects alone, even ones the person edits", async () => {
      const { A, E, X } = fx.people;
      const own = await projectWithOneArtifact(E);

      const r = await purge(X, E.user.id, E.user.email ?? '');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ projects: 1, artifacts: 1 });

      // P and e, where E edits, and everything of A's stay.
      expect(await projectsOf(A)).toContain(fx.ids.P);
      const artifacts = (await db().selectFrom('artifacts').select('id').execute()).map(
        (a) => a.id,
      );
      expect(artifacts).toEqual(expect.arrayContaining([fx.ids.p, fx.ids.q, fx.ids.e]));
      expect(artifacts).not.toContain(own.artifact);
      expect(await projectsOf(E)).toEqual([]);
      const members = await db()
        .selectFrom('project_members')
        .select('user_id')
        .where('project_id', '=', fx.ids.P)
        .execute();
      expect(members.map((m) => m.user_id)).toContain(E.user.id);
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
    });

    test('purge needs the email typed exactly', async () => {
      const { A, X } = fx.people;
      const owned = await projectsOf(A);
      for (const typed of ['nope', ` ${A.user.email}x`, A.user.id]) {
        const r = await purge(X, A.user.id, typed);
        expect(r.status, typed).toBe(400);
        expect(r.body).toMatchObject({
          error: {
            code: 'bad_request',
            message: t('purge.confirm'),
            details: { field: 'confirm_email' },
          },
        });
      }
      expect(
        (await restClient(ctx, X.cookie).post(`/admin/users/${A.user.id}/purge`, {})).status,
      ).toBe(400);
      // Nothing went, and the typed address may carry spaces around it.
      expect(await projectsOf(A)).toEqual(owned);
      expect((await purge(X, A.user.id, `  ${A.user.email}  `)).status).toBe(200);
    });

    test('a user without an email is confirmed by their id', async () => {
      const { X } = fx.people;
      const { user: owner } = await createSignedInUser(ctx, { kind: 'owner' });
      expect(owner.email).toBeNull();
      const wrong = await purge(X, owner.id, 'someone@example.test');
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ error: { details: { field: 'confirm_email' } } });
      const r = await purge(X, owner.id, owner.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ projects: 0, artifacts: 0 });

      // The same rule as a function: case is ignored, and the other identifier does not count.
      expect(() => assertPurgeConfirmed(owner, owner.id.toUpperCase())).not.toThrow();
      expect(() => assertPurgeConfirmed(X.user, X.user.email?.toUpperCase() ?? '')).not.toThrow();
      expect(() => assertPurgeConfirmed(X.user, X.user.id)).toThrow(t('purge.confirm'));
    });

    test('purge refuses members, and an unknown person answers 404', async () => {
      const { A, S, X } = fx.people;
      const denied = await purge(S, A.user.id, A.user.email ?? '');
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: { code: 'forbidden', message: t('auth.adminOnly') } });
      const unknown = await purge(X, 'usr_nobody', 'whoever');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({
        error: { code: 'not_found', message: t('auth.userNotFound') },
      });
    });

    test('a person deletes all of their own content with /me/purge, by session only', async () => {
      const { A, E } = fx.people;
      const info = vi.spyOn(ctx.deps.logger, 'info');

      const bearer = await ctx.request(
        '/api/v1/me/purge',
        apiInit(ctx, { body: { confirm_email: A.user.email }, bearer: A.token }),
      );
      expect(bearer.status).toBe(403);
      expect(await bearer.json()).toEqual({
        error: { code: 'forbidden', message: t('auth.sessionRequired') },
      });
      expect(await projectsOf(A)).not.toEqual([]);

      const wrong = await restClient(ctx, A.cookie).post('/me/purge', {
        confirm_email: E.user.email,
      });
      expect(wrong.status).toBe(400);

      const owned = await projectsOf(A);
      const r = await restClient(ctx, A.cookie).post('/me/purge', { confirm_email: A.user.email });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(PurgeResult.parse(r.body)).toEqual({ projects: owned.length, artifacts: 3 });
      expect(info).toHaveBeenCalledWith({ user_id: A.user.id, action: 'self.purge' }, 'moderation');

      // The person is still here: their library is a new default project and nothing else.
      const projects = await restClient(ctx, A.cookie).get<{
        items: { id: string; is_default: boolean; artifact_count: number }[];
      }>('/projects');
      expect(projects.status).toBe(200);
      expect(projects.body.items).toHaveLength(1);
      expect(projects.body.items[0]).toMatchObject({ is_default: true, artifact_count: 0 });
      expect(owned).not.toContain(projects.body.items[0]?.id);
    });

    test('the system deletes an artifact or a version without anyone holding a role', async () => {
      const { A } = fx.people;
      const { artifact, version } = await publishFiles(ctx, A.user, { 'index.html': '<p>One</p>' });
      const second = await publishFiles(
        ctx,
        A.user,
        { 'index.html': '<p>Two</p>' },
        {
          kind: 'new_version',
          artifactId: artifact.id,
          expectedVersionId: version.id,
        },
      );
      expect(second.version.number).toBe(2);

      expect(await systemDeleteVersion(ctx.deps, SYSTEM_SCOPE, artifact.id, 2)).toEqual({
        artifactDeleted: false,
        currentVersionId: expect.any(String),
      });
      expect(await systemDeleteVersion(ctx.deps, SYSTEM_SCOPE, artifact.id, 1)).toEqual({
        artifactDeleted: true,
        currentVersionId: null,
      });
      await expect(systemDeleteArtifact(ctx.deps, SYSTEM_SCOPE, artifact.id)).rejects.toMatchObject(
        {
          status: 410,
        },
      );
      await expect(
        systemDeleteArtifact(ctx.deps, SYSTEM_SCOPE, 'art_zzzzzzzzzzzzzzzzzzzz'),
      ).rejects.toMatchObject({ status: 404 });

      await systemDeleteArtifact(ctx.deps, SYSTEM_SCOPE, fx.ids.q);
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
    });

    describe('while someone keeps publishing', () => {
      /**
       * Deps whose blob store, after it removes a blob, first lets `person` publish a new page
       * into `projectId`, up to `times` times: a publish that lands while the purge deletes.
       */
      function racing(projectId: string, person: Person, times: number) {
        const real = ctx.deps.blobs;
        let left = times;
        const blobs: BlobStore = {
          put: (sha256, body, size) => real.put(sha256, body, size),
          get: (sha256, range) => real.get(sha256, range),
          has: (sha256) => real.has(sha256),
          list: () => real.list(),
          check: () => real.check(),
          removeStaleTemp: (before) => real.removeStaleTemp(before),
          async delete(sha256) {
            await real.delete(sha256);
            if (left-- <= 0) return;
            await publishFiles(
              ctx,
              person.user,
              { 'index.html': `<p>Late ${Math.random()}</p>` },
              { kind: 'new_artifact', projectId, name: null, tags: [] },
            );
          },
        };
        return { ...ctx.deps, blobs };
      }

      test('a publish that slips in is deleted by the next pass', async () => {
        const { E } = fx.people;
        const own = await projectWithOneArtifact(E);
        const result = await purgeSpace(racing(own.project, E, 1), SYSTEM_SCOPE, E.user.id);
        expect(result).toEqual({ projects: 1, artifacts: 2 });
        expect(await projectsOf(E)).toEqual([]);
        const left = await db()
          .selectFrom('artifacts')
          .select('id')
          .where('project_id', '=', own.project)
          .execute();
        expect(left).toEqual([]);
        expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
      });

      // PostgreSQL only: SQLite runs one transaction at a time, so a publish cannot be in flight.
      test.runIf(dialect === 'postgres')(
        'a publish still committing when the project is deleted slips in, too',
        async () => {
          const { E } = fx.people;
          const own = await projectWithOneArtifact(E);
          let purging: Promise<{ projects: number; artifacts: number }> | undefined;
          await db()
            .transaction()
            .execute(async (trx) => {
              // What a publish does: hold the project, add the artifact, commit a moment later.
              await trx
                .selectFrom('projects')
                .select('id')
                .where('id', '=', own.project)
                .forShare()
                .execute();
              await trx
                .insertInto('artifacts')
                .values({
                  id: newId('art'),
                  project_id: own.project,
                  name: 'Late',
                  kind: 'html',
                  current_version_id: null,
                  latest_number: 0,
                  created_by: E.user.id,
                  created_at: ctx.deps.clock.now(),
                  updated_at: ctx.deps.clock.now(),
                })
                .execute();
              purging = purgeSpace(ctx.deps, SYSTEM_SCOPE, E.user.id);
              // Long enough for the purge to reach the project and wait for the hold.
              await new Promise((resolve) => setTimeout(resolve, 500));
            });
          expect(await purging).toEqual({ projects: 1, artifacts: 2 });
          expect(await projectsOf(E)).toEqual([]);
        },
      );

      test('purge gives up with the busy message when new artifacts keep coming', async () => {
        const { E } = fx.people;
        const own = await projectWithOneArtifact(E);
        await expect(
          purgeSpace(racing(own.project, E, 100), SYSTEM_SCOPE, E.user.id),
        ).rejects.toMatchObject({ code: 'conflict', status: 409, message: t('purge.busy') });
        // The project is still there, with what arrived last; a later purge finishes the job.
        expect(await projectsOf(E)).toEqual([own.project]);
        expect(await purgeSpace(ctx.deps, SYSTEM_SCOPE, E.user.id)).toEqual({
          projects: 1,
          artifacts: 1,
        });
        expect(await projectsOf(E)).toEqual([]);
      });
    });
  });

  describe('in team mode', () => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, 'team');
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    test('purge is personal-only: 404 in team mode, as an unknown route', async () => {
      const { A, X } = fx.people;
      const unknown = await restClient(ctx, X.cookie).get('/nowhere');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({
        error: { code: 'not_found', message: t('error.notFound.message') },
      });

      const admin = await restClient(ctx, X.cookie).post(`/admin/users/${A.user.id}/purge`, {
        confirm_email: A.user.email,
      });
      expect({ status: admin.status, body: admin.body }).toEqual({
        status: 404,
        body: unknown.body,
      });
      const own = await restClient(ctx, A.cookie).post('/me/purge', {
        confirm_email: A.user.email,
      });
      expect({ status: own.status, body: own.body }).toEqual({ status: 404, body: unknown.body });

      // Nothing was deleted.
      const left = await ctx.deps.db.db.selectFrom('artifacts').select('id').execute();
      expect(left.map((row) => row.id)).toEqual(
        expect.arrayContaining([fx.ids.p, fx.ids.q, fx.ids.e]),
      );
    });
  });
});
