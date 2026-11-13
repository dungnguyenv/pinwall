import { PublishSession } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { MemberRole, UserRow } from '../../src/db/schema.ts';
import { scopeForUser } from '../../src/domain/spaces.ts';
import { checkTarget, commitVersion, type PublishTarget } from '../../src/domain/versions.ts';
import { t } from '../../src/lib/i18n.ts';
import { IngestBudget } from '../../src/publish/limits.ts';
import { BlobStager } from '../../src/publish/stage.ts';
import { referencedShas } from '../helpers/backup.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import type { Reply } from '../helpers/rest.ts';
import { emptyMeta } from '../helpers/staged.ts';
import {
  type Case,
  type CaseIds,
  c,
  expectCase,
  MODES,
  removeMember,
  type SpacesFixture,
  sameAnswer,
  spacesClient,
  spacesContext,
  spacesFixture,
  UNKNOWN_IDS,
} from './fixture.ts';

/** A path under `/api/v1`, as is or built from the ids the case runs on. */
type Path = string | ((i: CaseIds) => string);

const at = (path: Path, i: CaseIds) => (typeof path === 'string' ? path : path(i));

const post =
  (path: Path, body: (i: CaseIds) => object): Case['send'] =>
  (api, i) =>
    api.post(at(path, i), body(i));
const multipart =
  (path: Path, form: (i: CaseIds) => FormData): Case['send'] =>
  (api, i) =>
    api.form(at(path, i), form(i));

const newVersionOfp = (i: CaseIds) => ({ artifact_id: i.p, expected_version_id: i.pV2 });

const sessionInP = post('/publish-sessions', (i) => ({ target: { project_id: i.P } }));
const sessionInQ = post('/publish-sessions', (i) => ({ target: { project_id: i.Q } }));
const sessionOnp = post('/publish-sessions', (i) => ({ target: newVersionOfp(i) }));
const inlineIntoP = post('/publish/inline', (i) => ({
  target: { project_id: i.P },
  files: [{ path: 'index.html', content: '<p>Inline</p>' }],
}));
const uploadIntoP = multipart('/publish/upload', (i) => {
  const form = new FormData();
  form.append('target', JSON.stringify({ project_id: i.P }));
  form.append('file', new File(['<p>Web upload</p>'], 'index.html'));
  return form;
});
const restorepV1 = post(
  (i) => `/artifacts/${i.p}/versions/1/restore`,
  (i) => ({ expected_version_id: i.pV2 }),
);

/** Every way to publish: team mode keeps 1.0 (any member), personal mode needs `publish`. */
const PUBLISH: Case[] = [
  c('E', 'session for a new artifact in P', sessionInP, 201, 201),
  c('V', 'session for a new artifact in P', sessionInP, 201, 403),
  c('S', 'session for a new artifact in P', sessionInP, 201, 404),
  c('E', 'session for a new artifact in Q', sessionInQ, 201, 404),
  c('E', 'session for a new version of p', sessionOnp, 201, 201),
  c('V', 'session for a new version of p', sessionOnp, 201, 403),
  c('S', 'session for a new version of p', sessionOnp, 201, 404),
  c('V', 'inline into P', inlineIntoP, 201, 403),
  c('S', 'inline into P', inlineIntoP, 201, 404),
  c('V', 'web upload into P', uploadIntoP, 201, 403),
  c('S', 'web upload into P', uploadIntoP, 201, 404),
  c('E', 'restore version 1 of p', restorepV1, 201, 201),
  c('V', 'restore version 1 of p', restorepV1, 201, 403),
  c('S', 'restore version 1 of p', restorepV1, 201, 404),
];

/**
 * The two targets an editor of P may publish to, and the not-found key of each: what a commit
 * answers once its publisher can no longer see the target.
 */
const TARGETS: [string, (i: CaseIds) => PublishTarget, string][] = [
  [
    'a new artifact in P',
    (i) => ({ kind: 'new_artifact', projectId: i.P, name: null, tags: [] }),
    'project.notFound',
  ],
  [
    'a new version of p',
    (i) => ({ kind: 'new_version', artifactId: i.p, expectedVersionId: i.pV2 }),
    'artifact.notFound',
  ],
];

describe.each(dialects)('publishing by id on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
    });
    // Publishes change the fixture, so each test gets its own, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    test.each(PUBLISH)('$who: $name', (publishCase) => expectCase(ctx, fx, mode, publishCase));

    const db = () => ctx.deps.db.db;

    /** p's versions and every artifact: what a refused publish must leave as it was. */
    async function written(): Promise<{ versionsOfp: unknown[]; artifacts: string[] }> {
      const versionsOfp = await db()
        .selectFrom('versions')
        .selectAll()
        .where('artifact_id', '=', fx.ids.p)
        .orderBy('number')
        .execute();
      const artifacts = await db().selectFrom('artifacts').select('id').orderBy('id').execute();
      return { versionsOfp, artifacts: artifacts.map((row) => row.id) };
    }

    /** The keys in the blob store, sorted as `referencedShas` sorts them. */
    async function storedBlobs(): Promise<string[]> {
      const keys: string[] = [];
      for await (const key of ctx.deps.blobs.list()) keys.push(key);
      return keys.sort();
    }

    async function setRole(projectId: string, user: UserRow, role: MemberRole): Promise<void> {
      await db()
        .updateTable('project_members')
        .set({ role })
        .where('project_id', '=', projectId)
        .where('user_id', '=', user.id)
        .execute();
    }

    /** E's upload URL for a new version of p, made while E is an editor of P. */
    async function uploadUrlOfE(): Promise<string> {
      const r = await spacesClient(ctx, fx.people.E.cookie).post('/publish-sessions', {
        target: newVersionOfp(fx.ids),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return PublishSession.parse(r.body).upload_url;
    }

    /** Sends a page to an upload URL, as the documented single-file command does. */
    async function upload(url: string): Promise<Reply> {
      const res = await ctx.request(url, {
        method: 'POST',
        body: '<p>Version 3</p>',
        headers: { 'content-type': 'text/html' },
      });
      return { status: res.status, headers: res.headers, body: await res.json() };
    }

    test('an upload URL whose editor was removed is refused at commit, leaving nothing', async () => {
      const url = await uploadUrlOfE();
      const before = await written();
      await removeMember(ctx, fx.ids.P, fx.people.E.user.id);

      const r = await upload(url);
      if (mode === 'team') {
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body).toMatchObject({ artifact_id: fx.ids.p, version_number: 3 });
        return;
      }
      const unknown = await spacesClient(ctx, fx.people.E.cookie).post('/publish-sessions', {
        target: newVersionOfp(UNKNOWN_IDS),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      sameAnswer(r, unknown);
      expect(await written()).toEqual(before);
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
    });

    test('an upload URL of an editor made a viewer is refused at commit with reason role', async () => {
      const url = await uploadUrlOfE();
      const before = await written();
      await setRole(fx.ids.P, fx.people.E.user, 'viewer');

      const r = await upload(url);
      if (mode === 'team') {
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        return;
      }
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body).toEqual({
        error: {
          code: 'forbidden',
          message: t('spaces.role.publish'),
          details: { reason: 'role' },
        },
      });
      expect(await written()).toEqual(before);
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
    });

    /**
     * Commits a page to `target` as E, staged as an upload stages it: kept on success, removed
     * with whatever the stager added when the commit is refused, which is rethrown.
     */
    async function commitAsE(target: PublishTarget): Promise<void> {
      const stager = new BlobStager(ctx.deps, new IngestBudget(ctx.deps.config.limits));
      const page = Buffer.from(`<p>A ${target.kind} by E</p>`);
      try {
        await stager.stage('index.html', page, page.length);
        await commitVersion(ctx.deps, fx.people.E.user, target, {
          entryPath: 'index.html',
          kind: 'html',
          files: stager.files,
          meta: emptyMeta(),
          message: null,
          source: 'api',
        });
        stager.release();
      } catch (error) {
        await stager.abort();
        throw error;
      }
    }

    test.each(TARGETS)(
      'the commit checks again after the target check passed: %s',
      async (_name, targetOf, notFoundKey) => {
        const { E } = fx.people;
        const target = targetOf(fx.ids);
        await checkTarget(ctx.deps, scopeForUser(ctx.deps, E.user), target);
        const before = await written();
        await removeMember(ctx, fx.ids.P, E.user.id);

        const commit = commitAsE(target);
        if (mode === 'team') {
          await commit;
          return;
        }
        await expect(commit).rejects.toMatchObject({
          status: 404,
          code: 'not_found',
          message: t(notFoundKey),
        });
        expect(await written()).toEqual(before);
        expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
      },
    );

    test.each(TARGETS)(
      'the commit checks the role again after the target check passed: %s',
      async (_name, targetOf) => {
        const { E } = fx.people;
        const target = targetOf(fx.ids);
        await checkTarget(ctx.deps, scopeForUser(ctx.deps, E.user), target);
        const before = await written();
        await setRole(fx.ids.P, E.user, 'viewer');

        const commit = commitAsE(target);
        if (mode === 'team') {
          await commit;
          return;
        }
        await expect(commit).rejects.toMatchObject({
          status: 403,
          code: 'forbidden',
          details: { reason: 'role' },
        });
        expect(await written()).toEqual(before);
        expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
      },
    );
  });
});
