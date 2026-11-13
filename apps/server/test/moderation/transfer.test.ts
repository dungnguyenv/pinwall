import { randomBytes } from 'node:crypto';
import { ArtifactList, ContentGrant, PublishSession } from '@pinwall/shared';
import type { Transaction } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { revokeAllCredentials } from '../../src/auth/revoke.ts';
import type { Database } from '../../src/db/schema.ts';
import { holdArtifact } from '../../src/domain/artifacts.ts';
import { createProject } from '../../src/domain/projects.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import {
  defaultProjectFor,
  holdRoleIn,
  lockProject,
  roleIn,
  scopeForUser,
} from '../../src/domain/spaces.ts';
import { findUserByRef, type TransferResult, transferContent } from '../../src/domain/transfer.ts';
import { usageOf } from '../../src/domain/usage.ts';
import type { PublishTarget } from '../../src/domain/versions.ts';
import { SSE_HEARTBEAT_MS } from '../../src/http/sse.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../../src/lib/ids.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects, untilWaitingOnALock } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { readSse } from '../helpers/review.ts';
import { listen } from '../helpers/socket.ts';
import {
  addMember,
  MODES,
  type Person,
  type SpacesFixture,
  spacesClient,
  spacesFixture,
  T,
  withVisibility,
} from '../spaces/fixture.ts';
import { moderationContext } from './helpers.ts';

const RETRY = 'retry: 5000\n\n';
/** How long a stream that should stay open is watched for an end. */
const STAYS_OPEN_MS = 300;

/** Only the heartbeat's interval is faked: sockets, the database and `readSse` keep real time. */
const fakeHeartbeat = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
/** Moves the faked interval on to the next heartbeat: a ping, then the access check. */
const heartbeat = () => vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);

/** The grant token in a single-domain content URL, `…/c/<token>/`. */
function tokenIn(url: string): string {
  const token = /\/c\/([0-9a-hjkmnp-tv-z]{32})\/$/.exec(url)?.[1];
  if (token === undefined) throw new Error(`Not a content URL: ${url}`);
  return token;
}

/** What `work` rejects with, which must be an AppError. */
async function appErrorOf(work: Promise<unknown>): Promise<AppError> {
  const error = await work.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof AppError)) throw new Error(`Expected an AppError, got ${String(error)}`);
  return error;
}

describe.each(dialects)('transferring a space on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let server: Awaited<ReturnType<typeof listen>>;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, mode);
      server = await listen(ctx.app, ctx.deps.config);
    });
    // Transfers move projects for good, so each test gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await server?.close();
      await ctx?.close();
    });

    const db = () => ctx.deps.db.db;
    const api = (person: Person) => spacesClient(ctx, person.cookie);
    const usage = (person: Person) => usageOf(db(), ctx.deps.config, person.user.id);

    /** The ids of the projects `person` owns, sorted. */
    const projectsOf = async (person: Person) =>
      (
        await db()
          .selectFrom('projects')
          .select('id')
          .where('owner_id', '=', person.user.id)
          .orderBy('id')
          .execute()
      ).map((row) => row.id);

    const project = (id: string) =>
      db().selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    /** The artifacts `person` finds in their library. */
    async function listed(person: Person): Promise<string[]> {
      const r = await api(person).get('/artifacts?limit=200');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return ArtifactList.parse(r.body).items.map((artifact) => artifact.id);
    }

    /** Who made the share link `linkId`. */
    const makerOf = async (linkId: string) =>
      (
        await db()
          .selectFrom('share_links')
          .select('created_by')
          .where('id', '=', linkId)
          .executeTakeFirstOrThrow()
      ).created_by;

    /** A link by `maker` that follows the current version, with no password. */
    const linkTo = (maker: Person, artifactId: string) =>
      createShareLink(ctx.deps, maker.user, artifactId, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: true,
      });

    /** The share viewer's status for `token`, as a guest asks for it. */
    const shareStatus = async (token: string) =>
      (await ctx.request(`/api/v1/share/${token}`, apiInit(ctx))).status;

    /**
     * A project of E's own, which A joins as `role`, with an artifact E published: A's work there
     * stays A's, since only what A owns moves.
     */
    async function elsewhere(role: 'editor' | 'viewer'): Promise<{ project: string; o: string }> {
      const { A, E } = fx.people;
      const own = await createProject(ctx.deps, E.user, { name: 'Elsewhere' });
      await addMember(ctx, own.id, A.user.id, role, E.user.id);
      const { artifact } = await publishFiles(
        ctx,
        E.user,
        { 'index.html': '<!doctype html><h1>Elsewhere</h1>' },
        { kind: 'new_artifact', projectId: own.id, name: null, tags: [] },
      );
      return { project: own.id, o: artifact.id };
    }

    /** A grant of `mode` that `person` gets on version 1 of the artifact, through the preview. */
    async function grantOf(person: Person, artifactId: string): Promise<string> {
      const r = await ctx.request(
        `/api/v1/artifacts/${artifactId}/versions/1/preview?mode=review`,
        apiInit(ctx, { cookie: person.cookie }),
      );
      expect(r.status, await r.clone().text()).toBe(200);
      return tokenIn(ContentGrant.parse(await r.json()).url);
    }

    const served = async (token: string) => (await fetchContent(ctx, token, 'index.html')).status;

    test('transfer moves every project of A to B, and B sees all of it', async () => {
      const { A, V } = fx.people;
      const owned = await projectsOf(A);
      const before = { A: await usage(A), V: await usage(V) };
      const info = vi.spyOn(ctx.deps.logger, 'info');

      const result = await transferContent(ctx.deps, A.user, V.user);
      expect(result).toEqual({
        projects: owned.length,
        artifacts: 3,
        shareLinks: 2,
        membershipsDropped: 1,
        renamedDefault: null,
        grantsEnded: 0,
      });
      for (const id of [fx.ids.P, fx.ids.Q]) {
        expect(await project(id)).toMatchObject({
          owner_id: V.user.id,
          updated_at: ctx.deps.clock.now(),
        });
      }
      expect(await projectsOf(A)).toEqual([]);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'transfer',
          from_id: A.user.id,
          to_id: V.user.id,
          projects: owned.length,
          artifacts: 3,
        }),
        'transfer',
      );

      const moved = [fx.ids.p, fx.ids.q, fx.ids.e];
      expect(await listed(V)).toEqual(expect.arrayContaining(moved));
      if (mode === 'personal') {
        expect(await usage(V)).toEqual({
          bytes: before.A.bytes + before.V.bytes,
          artifacts: before.A.artifacts + before.V.artifacts,
        });
        expect(await usage(A)).toEqual({ bytes: 0, artifacts: 0 });
        const seenByA = await listed(A);
        for (const id of moved) expect(seenByA).not.toContain(id);
      } else {
        // Team mode counts what each person published, which nothing changes.
        expect(await usage(A)).toEqual(before.A);
        expect(await usage(V)).toEqual(before.V);
        expect(await listed(A)).toEqual(expect.arrayContaining(moved));
      }
    });

    test("links A made keep opening and now belong to B; others' links stay", async () => {
      const { A, E, V } = fx.people;
      const other = await elsewhere('editor');
      const opened = [
        await linkTo(A, fx.ids.p),
        await linkTo(A, fx.ids.q),
        await linkTo(E, fx.ids.e),
      ];
      const aElsewhere = await linkTo(A, other.o);

      const result = await transferContent(ctx.deps, A.user, V.user);
      // The fixture's two links on p and q, and the two made here.
      expect(result.shareLinks).toBe(4);
      expect(await makerOf(fx.ids.pLink)).toBe(V.user.id);
      expect(await makerOf(fx.ids.qLink)).toBe(V.user.id);
      expect(await makerOf(fx.ids.eLink)).toBe(E.user.id);
      expect(await makerOf(opened[0]?.row.id ?? '')).toBe(V.user.id);
      expect(await makerOf(opened[2]?.row.id ?? '')).toBe(E.user.id);
      // A link in a project A does not own stays A's.
      expect(await makerOf(aElsewhere.row.id)).toBe(A.user.id);
      for (const link of [...opened, aElsewhere]) expect(await shareStatus(link.token)).toBe(200);
    });

    test("members stay; B's own membership in a moved project is dropped", async () => {
      const { A, E, V } = fx.people;
      const result = await transferContent(ctx.deps, A.user, V.user);
      expect(result.membershipsDropped).toBe(1);

      const members = await db()
        .selectFrom('project_members')
        .select(['user_id', 'role'])
        .where('project_id', '=', fx.ids.P)
        .execute();
      expect(members).toEqual([{ user_id: E.user.id, role: 'editor' }]);
      const scope = scopeForUser(ctx.deps, V.user);
      expect(await roleIn(db(), scope, fx.ids.P)).toBe('owner');
      expect(await roleIn(db(), scopeForUser(ctx.deps, E.user), fx.ids.P)).toBe(
        mode === 'personal' ? 'editor' : 'owner',
      );
    });

    /** A's and `target`'s own default projects, made as personal mode makes them. */
    async function defaults(target: Person | null) {
      const personal = withVisibility(ctx.deps, 'personal');
      const own = (person: Person) =>
        defaultProjectFor(personal, scopeForUser(personal, person.user));
      return { a: await own(fx.people.A), target: target === null ? null : await own(target) };
    }

    test('when both have a default project, A\'s becomes "Default (from A)"', async () => {
      const { A, V } = fx.people;
      const made = await defaults(V);
      const vDefault = made.target;
      if (vDefault === null) throw new Error('V has no default project');

      const result = await transferContent(ctx.deps, A.user, V.user);
      expect(result.renamedDefault).toBe('Default (from A)');
      expect(t('transfer.defaultName', { name: 'A' })).toBe('Default (from A)');
      expect(await project(made.a.id)).toMatchObject({
        is_default: 0,
        name: 'Default (from A)',
        owner_id: V.user.id,
      });
      expect(await project(vDefault.id)).toMatchObject({
        is_default: 1,
        name: vDefault.name,
        owner_id: V.user.id,
      });
      const vDefaults = await db()
        .selectFrom('projects')
        .select('id')
        .where('owner_id', '=', V.user.id)
        .where('is_default', '=', 1)
        .execute();
      expect(vDefaults).toEqual([{ id: vDefault.id }]);
    });

    test("a target without a default takes A's as its own", async () => {
      const { A } = fx.people;
      const made = await defaults(null);
      const { user, cookie } = await createSignedInUser(ctx, { kind: 'oidc', name: 'N' });
      const N: Person = { user, cookie, token: '' };

      const result = await transferContent(ctx.deps, A.user, N.user);
      expect(result.renamedDefault).toBeNull();
      expect(await project(made.a.id)).toMatchObject({
        is_default: 1,
        name: made.a.name,
        owner_id: N.user.id,
      });
      expect(await projectsOf(N)).toEqual([fx.ids.P, fx.ids.Q, made.a.id].sort());
    });

    test("A's grants on moved artifacts end in personal mode only", async () => {
      const { A, V } = fx.people;
      const other = await elsewhere('viewer');
      const onP = await grantOf(A, fx.ids.p);
      const kept = await grantOf(A, other.o);

      const result = await transferContent(ctx.deps, A.user, V.user);
      expect(result.grantsEnded).toBe(mode === 'personal' ? 1 : 0);
      expect(await served(onP)).toBe(mode === 'personal' ? 410 : 200);
      expect(await served(kept)).toBe(200);
      const left = await db()
        .selectFrom('content_grants')
        .select('token')
        .where('user_id', '=', A.user.id)
        .orderBy('token')
        .execute();
      expect(left.map((row) => row.token)).toEqual(
        mode === 'personal' ? [kept] : [onP, kept].sort(),
      );
    });

    test('A loses sight while the artifact is open: stream, grant and Recent', async () => {
      fakeHeartbeat();
      const { A, V } = fx.people;
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/artifacts/${fx.ids.p}/events`,
        {
          headers: { cookie: A.cookie },
        },
      );
      expect(res.status, res.status === 200 ? '' : await res.text()).toBe(200);
      const stream = readSse(res);
      expect(await stream.next()).toBe(RETRY);
      // The preview is a view too: p is in A's Recent.
      const grant = await grantOf(A, fx.ids.p);
      const recent = async () => {
        const r = await api(A).get('/artifacts/recent');
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return ArtifactList.parse(r.body).items.map((artifact) => artifact.id);
      };
      expect(await recent()).toContain(fx.ids.p);

      await transferContent(ctx.deps, A.user, V.user);
      await heartbeat();
      if (mode === 'personal') {
        expect(await stream.done()).toBe(true);
        expect(await served(grant)).toBe(410);
        expect(await recent()).not.toContain(fx.ids.p);
        return;
      }
      expect(await stream.done(STAYS_OPEN_MS)).toBe(false);
      await stream.cancel();
      expect(await served(grant)).toBe(200);
      expect(await recent()).toContain(fx.ids.p);
    });

    test('an upload URL A made before the transfer is refused at commit', async () => {
      const { A, V } = fx.people;
      const session = async (target: Record<string, string>) => {
        const r = await api(A).post('/publish-sessions', { target });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        return new URL(PublishSession.parse(r.body).upload_url).pathname;
      };
      const newVersion = await session({ artifact_id: fx.ids.p, expected_version_id: fx.ids.pV2 });
      const intoP = await session({ project_id: fx.ids.P });
      const counts = async () => ({
        artifacts: (
          await db()
            .selectFrom('artifacts')
            .select('id')
            .where('project_id', '=', fx.ids.P)
            .execute()
        ).length,
        versions: (
          await db()
            .selectFrom('versions')
            .select('id')
            .where('artifact_id', '=', fx.ids.p)
            .execute()
        ).length,
      });
      const before = await counts();

      await transferContent(ctx.deps, A.user, V.user);
      for (const path of [newVersion, intoP]) {
        const res = await ctx.request(path, {
          method: 'POST',
          body: '<!doctype html><h1>Late</h1>',
          headers: { 'content-type': 'text/html' },
        });
        expect(res.status, await res.text()).toBe(mode === 'personal' ? 404 : 201);
      }
      if (mode === 'personal') {
        expect(await counts()).toEqual(before);
      } else {
        expect(await counts()).toEqual({
          artifacts: before.artifacts + 1,
          versions: before.versions + 1,
        });
      }
    });

    test('transfer to oneself is refused and changes nothing', async () => {
      const { A } = fx.people;
      const owned = await projectsOf(A);
      const error = await appErrorOf(transferContent(ctx.deps, A.user, A.user));
      expect(error).toMatchObject({
        status: 400,
        code: 'bad_request',
        message: t('transfer.same'),
      });
      expect(await projectsOf(A)).toEqual(owned);
      expect(await makerOf(fx.ids.pLink)).toBe(A.user.id);
    });

    test('findUserByRef finds by id and by email ignoring case, and refuses unknown, malformed and shared emails', async () => {
      const { A } = fx.people;
      const email = A.user.email ?? '';
      expect((await findUserByRef(db(), A.user.id)).id).toBe(A.user.id);
      // The fixture's addresses start with the id, `usr_…@`: still an email.
      expect((await findUserByRef(db(), email)).id).toBe(A.user.id);
      expect((await findUserByRef(db(), email.toUpperCase())).id).toBe(A.user.id);
      expect((await findUserByRef(db(), ` ${email} `)).id).toBe(A.user.id);

      for (const ref of ['usr_zzzzzzzzzzzzzzzzzzzz', 'nobody@example.test']) {
        expect(await appErrorOf(findUserByRef(db(), ref))).toMatchObject({
          status: 404,
          message: t('transfer.noUser', { ref }),
        });
      }
      expect(await appErrorOf(findUserByRef(db(), 'nobody'))).toMatchObject({
        status: 400,
        message: t('transfer.badRef', { ref: 'nobody' }),
      });

      // The local owner account and an OIDC account may use one address.
      const shared = `dn-${randomBytes(4).toString('hex')}@example.test`;
      const owner = await createSignedInUser(ctx, { kind: 'owner' });
      const oidc = await createSignedInUser(ctx, { kind: 'oidc' });
      await db()
        .updateTable('users')
        .set({ email: shared })
        .where('id', 'in', [owner.user.id, oidc.user.id])
        .execute();
      // Made at the same moment (the clock stands still): listed by id.
      const ids = [owner.user.id, oidc.user.id].sort();
      const ref = shared.toUpperCase();
      expect(await appErrorOf(findUserByRef(db(), ref))).toMatchObject({
        status: 409,
        code: 'conflict',
        message: t('transfer.ambiguous', { ref, count: 2, ids: ids.join(', ') }),
        details: { user_ids: ids },
      });
    });
  });
});

describe.runIf(dialects.includes('postgres'))('a transfer taking turns on Postgres', () => {
  let ctx: TestContext;
  let fx: SpacesFixture;
  beforeAll(async () => {
    // Two transactions at once, and the query that watches one of them wait.
    ctx = await moderationContext('postgres', 'personal', { PINWALL_DATABASE_POOL_SIZE: '4' });
  });
  beforeEach(async () => {
    fx = await spacesFixture(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Runs `hold` in a transaction of its own, then moves A's projects to `to` while it is open.
   * Once the transfer waits on a lock (or has settled), the transaction goes on with `then` and
   * commits. Returns whether the transfer had settled before that, and what it returned.
   */
  async function transferDuring(
    to: Person,
    hold: (trx: Transaction<Database>) => Promise<unknown>,
    then: (trx: Transaction<Database>) => Promise<unknown>,
  ): Promise<{ settledFirst: boolean; result: TransferResult }> {
    const { db } = ctx.deps.db;
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = db.transaction().execute(async (trx) => {
      await hold(trx);
      held();
      await released;
      await then(trx);
    });
    try {
      await Promise.race([holding, transaction]);
      let settled = false;
      const transfer = transferContent(ctx.deps, fx.people.A.user, to.user);
      void transfer.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await untilWaitingOnALock(db, transfer);
      const settledFirst = settled;
      release();
      await transaction;
      return { settledFirst, result: await transfer };
    } finally {
      release();
    }
  }

  test('a membership change in a moved project makes the transfer wait, and its member is dropped', async () => {
    const { A, S } = fx.people;
    // A, as P's owner, lets S in: the change holds P, and commits once the transfer waits.
    const { settledFirst, result } = await transferDuring(
      S,
      (trx) => lockProject(trx, 'postgres', fx.ids.P),
      (trx) =>
        trx
          .insertInto('project_members')
          .values({
            project_id: fx.ids.P,
            user_id: S.user.id,
            role: 'editor',
            added_by: A.user.id,
            created_at: T,
          })
          .execute(),
    );
    expect(settledFirst).toBe(false);
    expect(result.membershipsDropped).toBe(1);
    const members = await ctx.deps.db.db
      .selectFrom('project_members')
      .select('user_id')
      .where('project_id', '=', fx.ids.P)
      .where('user_id', '=', S.user.id)
      .execute();
    expect(members).toEqual([]);
  });

  test("revoking A's links while A's projects move does not deadlock", async () => {
    const { A, V } = fx.people;
    const { db } = ctx.deps.db;
    // One open link of A in each moved project, on artifacts whose ids cross the projects'
    // order: the artifact in the first project sorts after the one in the second. Visited by
    // artifact id alone, the revocation holds the second project and then asks for the first,
    // which the transfer holds while it asks for the second.
    const [low, high] = [fx.ids.P, fx.ids.Q].sort() as [string, string];
    const inHigh = high === fx.ids.P ? fx.ids.p : fx.ids.q;
    await db
      .updateTable('share_links')
      .set({ revoked_at: T })
      .where('id', '=', low === fx.ids.P ? fx.ids.pLink : fx.ids.qLink)
      .execute();
    let inLow = '';
    for (let tries = 0; inLow <= inHigh; tries++) {
      if (tries === 20) throw new Error('No new artifact sorted after the other project’s');
      const target: PublishTarget = { kind: 'new_artifact', projectId: low, name: null, tags: [] };
      inLow = (await publishFiles(ctx, A.user, { 'index.html': '<p>low</p>' }, target)).artifact.id;
    }
    await createShareLink(ctx.deps, A.user, inLow, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: false,
    });

    // A transaction holds inLow, so the revocation waits there, with whatever it already holds.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom('artifacts').select('id').where('id', '=', inLow).forUpdate().execute();
      held();
      await released;
    });
    try {
      await holding;
      const revoking = revokeAllCredentials(ctx.deps, A.user.id);
      await untilWaitingOnALock(db, revoking);
      const transfer = transferContent(ctx.deps, A.user, V.user);
      // The transfer waits for the revocation, or (in project order) does not wait at all.
      await untilWaitingOnALock(db, transfer, 2);
      release();
      const [revoked, moved] = await Promise.allSettled([revoking, transfer]);
      expect(revoked.status, String((revoked as PromiseRejectedResult).reason)).toBe('fulfilled');
      expect(moved.status, String((moved as PromiseRejectedResult).reason)).toBe('fulfilled');
      expect((moved as PromiseFulfilledResult<TransferResult>).value.projects).toBe(2);
    } finally {
      release();
      await blocker;
    }
  });

  test('a link A makes while the transfer waits is handed over too', async () => {
    const { A, V } = fx.people;
    const scope = scopeForUser(ctx.deps, A.user);
    const linkId = newId('shr');
    // A's link on p, as createShareLink makes it: the artifact, then the project, then the row.
    const { settledFirst, result } = await transferDuring(
      V,
      async (trx) => {
        await holdArtifact(trx, 'postgres', scope, fx.ids.p, T);
        await holdRoleIn(trx, 'postgres', scope, fx.ids.P);
      },
      (trx) =>
        trx
          .insertInto('share_links')
          .values({
            id: linkId,
            artifact_id: fx.ids.p,
            version_id: null,
            token_hash: hashSecret(newSecret()),
            password_hash: null,
            allow_comments: 1,
            expires_at: null,
            created_by: A.user.id,
            created_at: T,
            last_used_at: null,
            revoked_at: null,
          })
          .execute(),
    );
    expect(settledFirst).toBe(false);
    // The fixture's links on p and q, and this one.
    expect(result.shareLinks).toBe(3);
    const link = await ctx.deps.db.db
      .selectFrom('share_links')
      .select('created_by')
      .where('id', '=', linkId)
      .executeTakeFirstOrThrow();
    expect(link.created_by).toBe(V.user.id);
  });
});
