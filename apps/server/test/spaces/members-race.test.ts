import type { Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createGrant, revokeProjectGrants } from '../../src/content/grants.ts';
import type { Database, UserRow } from '../../src/db/schema.ts';
import { lockArtifact } from '../../src/domain/artifacts.ts';
import { addReply } from '../../src/domain/comments.ts';
import { deleteArtifact, deleteVersion } from '../../src/domain/deletion.ts';
import { removeMember, setMemberRole } from '../../src/domain/members.ts';
import { createShareLink, revokeProjectShareLinksOf } from '../../src/domain/shares.ts';
import {
  holdProject,
  holdRoleIn,
  lockProject,
  type Scope,
  SYSTEM_SCOPE,
  scopeForUser,
} from '../../src/domain/spaces.ts';
import { hashSecret, newId, newSecret } from '../../src/lib/ids.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects, untilWaitingOnALock } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type SpacesFixture, spacesContext, spacesFixture, T } from './fixture.ts';

/** A transaction that fails on any use: a call handed it and returning shows it ran no query. */
const unusable = new Proxy(
  {},
  {
    get: (_target, property) => () => {
      throw new Error(`The transaction was used (${String(property)})`);
    },
  },
) as Transaction<Database>;

test('holdRoleIn runs no query in team mode or for the system', async () => {
  const user = { id: 'usr_teamviewer' } as UserRow;
  const teamScope: Scope = { kind: 'viewer', user, visibility: 'team', admin: false };
  expect(await holdRoleIn(unusable, 'postgres', teamScope, 'prj_x')).toBe('owner');
  expect(await holdRoleIn(unusable, 'postgres', SYSTEM_SCOPE, 'prj_x')).toBe('owner');
});

/** A promise and what settles it, for a transaction a test keeps open. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe.runIf(dialects.includes('postgres'))('membership changes on Postgres', () => {
  let ctx: TestContext;
  let fx: SpacesFixture;
  beforeAll(async () => {
    ctx = await spacesContext('postgres', 'personal');
  });
  // Tests take E out of P, so each gets its own fixture, in the shared context.
  beforeEach(async () => {
    fx = await spacesFixture(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Runs `hold` in a transaction of its own, then starts `contender` and lets it run until it
   * waits on a lock (or settles). Only then does the transaction go on with `then` and commit.
   * Returns whether the contender had settled before that, and its outcome: what it returned,
   * or what it threw.
   */
  async function contend(
    hold: (trx: Transaction<Database>) => Promise<unknown>,
    contender: () => Promise<unknown>,
    then: (trx: Transaction<Database>) => Promise<unknown> = async () => {},
  ): Promise<{ settledFirst: boolean; outcome: unknown }> {
    const { db } = ctx.deps.db;
    const held = gate();
    const release = gate();
    const transaction = db.transaction().execute(async (trx) => {
      await hold(trx);
      held.open();
      await release.opened;
      await then(trx);
    });
    try {
      await Promise.race([held.opened, transaction]);
      let settled = false;
      const outcome = contender().then(
        (value) => value,
        (err: unknown) => err,
      );
      void outcome.then(() => {
        settled = true;
      });
      await untilWaitingOnALock(db, outcome);
      const settledFirst = settled;
      release.open();
      await transaction;
      return { settledFirst, outcome: await outcome };
    } finally {
      release.open();
    }
  }

  /** A membership change taking E out of P, up to its commit: the project, then the row. */
  async function removingE(trx: Transaction<Database>): Promise<void> {
    await lockProject(trx, 'postgres', fx.ids.P);
    await trx
      .deleteFrom('project_members')
      .where('project_id', '=', fx.ids.P)
      .where('user_id', '=', fx.people.E.user.id)
      .execute();
  }

  /**
   * What E has made since the fixture: share links on p, versions of p past 2, replies on
   * pThread, and artifacts in P other than e.
   */
  async function madeByE() {
    const { db } = ctx.deps.db;
    const E = fx.people.E.user.id;
    return {
      artifacts: await db
        .selectFrom('artifacts')
        .select('id')
        .where('project_id', '=', fx.ids.P)
        .where('created_by', '=', E)
        .where('id', '!=', fx.ids.e)
        .execute(),
      links: await db
        .selectFrom('share_links')
        .select('id')
        .where('artifact_id', '=', fx.ids.p)
        .where('created_by', '=', E)
        .execute(),
      versions: await db
        .selectFrom('versions')
        .select('number')
        .where('artifact_id', '=', fx.ids.p)
        .where('number', '>', 2)
        .execute(),
      replies: await db
        .selectFrom('comments')
        .select('id')
        .where('parent_id', '=', fx.ids.pThread)
        .where('author_user_id', '=', E)
        .execute(),
    };
  }

  /** When the link `linkId` was revoked, or null. */
  async function revokedAt(linkId: string): Promise<number | null> {
    const row = await ctx.deps.db.db
      .selectFrom('share_links')
      .select('revoked_at')
      .where('id', '=', linkId)
      .executeTakeFirstOrThrow();
    return row.revoked_at;
  }

  /** Whether a tombstone of `kind` holds `key`. */
  async function tombstoned(kind: 'content_grant' | 'share_link', key: string): Promise<boolean> {
    const row = await ctx.deps.db.db
      .selectFrom('tombstones')
      .select('key')
      .where('kind', '=', kind)
      .where('key', '=', key)
      .executeTakeFirst();
    return row !== undefined;
  }

  const ownerScope = () => scopeForUser(ctx.deps, fx.people.A.user);

  test.each<[string, (fx: SpacesFixture) => Promise<unknown>]>([
    [
      'a share link',
      (fx) =>
        createShareLink(ctx.deps, fx.people.E.user, fx.ids.p, {
          versionId: null,
          password: null,
          expiresAt: null,
          allowComments: true,
        }),
    ],
    [
      'a new version',
      (fx) =>
        publishFiles(
          ctx,
          fx.people.E.user,
          { 'index.html': '<!doctype html><h1>Version 3</h1>' },
          { kind: 'new_version', artifactId: fx.ids.p, expectedVersionId: fx.ids.pV2 },
        ),
    ],
    [
      'a reply',
      (fx) => addReply(ctx.deps, { kind: 'member', user: fx.people.E.user }, fx.ids.pThread, 'x'),
    ],
    // Waits in the statement that also checks sight; only the role read after it sees the removal.
    [
      'a new artifact',
      (fx) =>
        publishFiles(
          ctx,
          fx.people.E.user,
          { 'index.html': '<!doctype html><h1>New in P</h1>' },
          { kind: 'new_artifact', projectId: fx.ids.P, name: null, tags: [] },
        ),
    ],
  ])('%s by a member being removed waits, then is refused', async (_name, write) => {
    const { settledFirst, outcome } = await contend(removingE, () => write(fx));
    expect(settledFirst, 'the write waited for the removal').toBe(false);
    expect(outcome).toMatchObject({ status: 404 });
    expect(await madeByE()).toEqual({ artifacts: [], links: [], versions: [], replies: [] });
  });

  test.each<[string, () => Promise<unknown>, unknown]>([
    [
      'a removal',
      () => removeMember(ctx.deps, ownerScope(), fx.ids.P, fx.people.E.user.id),
      undefined,
    ],
    [
      'a demotion',
      () => setMemberRole(ctx.deps, ownerScope(), fx.ids.P, fx.people.E.user.id, 'viewer'),
      expect.objectContaining({ role: 'viewer' }),
    ],
  ])('%s waits for a link in flight, then revokes it', async (_name, change, result) => {
    const { E } = fx.people;
    const linkId = newId('shr');
    // A share link E is making: the write holds P and has read E's role, and has not committed.
    const making = async (trx: Transaction<Database>) => {
      expect(await holdRoleIn(trx, 'postgres', scopeForUser(ctx.deps, E.user), fx.ids.P)).toBe(
        'editor',
      );
      await trx
        .insertInto('share_links')
        .values({
          id: linkId,
          artifact_id: fx.ids.p,
          version_id: null,
          token_hash: hashSecret(newSecret()),
          password_hash: null,
          allow_comments: 1,
          expires_at: null,
          created_by: E.user.id,
          created_at: T,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();
    };
    const { settledFirst, outcome } = await contend(making, change);
    expect(settledFirst, 'the membership change waited for the link').toBe(false);
    expect(outcome).toEqual(result);
    expect(await revokedAt(linkId)).toBe(T);
  });

  test('a removal locks no artifact row', async () => {
    const { E } = fx.people;
    // E's own link and grant on p, which the removal ends while p is locked.
    const { row: link } = await createShareLink(ctx.deps, E.user, fx.ids.p, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: true,
    });
    const grant = await createGrant(ctx.deps, {
      versionId: fx.ids.pV2,
      mode: 'review',
      user: E.user,
    });
    const { settledFirst, outcome } = await contend(
      // As a deletion of p starts: the artifact first.
      (trx) => lockArtifact(trx, 'postgres', SYSTEM_SCOPE, fx.ids.p),
      () => removeMember(ctx.deps, ownerScope(), fx.ids.P, E.user.id),
      // Then the project, which the removal no longer holds.
      (trx) => holdProject(trx, 'postgres', 'personal', fx.ids.P),
    );
    expect(settledFirst, 'the removal finished while p was locked').toBe(true);
    expect(outcome).toBeUndefined();
    expect(await revokedAt(link.id)).toBe(T);
    expect(await tombstoned('content_grant', grant.token)).toBe(true);
  });

  test.each<[string, (fx: SpacesFixture) => Promise<unknown>, unknown]>([
    [
      'an artifact deletion',
      (fx) => deleteArtifact(ctx.deps, { user: fx.people.A.user, via: 'session' }, fx.ids.p),
      undefined,
    ],
    [
      'a version deletion',
      (fx) => deleteVersion(ctx.deps, { user: fx.people.A.user, via: 'session' }, fx.ids.p, 2),
      expect.objectContaining({ artifactDeleted: false }),
    ],
  ])(
    '%s in the project waits for a removal, without a deadlock',
    async (_name, deletion, result) => {
      const { E } = fx.people;
      // E's link on version 2 and grant on it: both go with either deletion, and with the removal.
      const { row: link } = await createShareLink(ctx.deps, E.user, fx.ids.p, {
        versionId: fx.ids.pV2,
        password: null,
        expiresAt: null,
        allowComments: true,
      });
      const grant = await createGrant(ctx.deps, {
        versionId: fx.ids.pV2,
        mode: 'review',
        user: E.user,
      });
      const now = ctx.deps.clock.now();
      const { settledFirst, outcome } = await contend(
        // The removal as `endProjectAccess` runs it, paused between E's links and E's grants: a
        // deletion that went ahead now would tombstone the grant first, then wait on the link.
        async (trx) => {
          await removingE(trx);
          await revokeProjectShareLinksOf(trx, E.user.id, fx.ids.P, now);
        },
        () => deletion(fx),
        (trx) => revokeProjectGrants(trx, E.user.id, fx.ids.P, now),
      );
      expect(settledFirst, 'the deletion waited for the removal').toBe(false);
      expect(outcome).toEqual(result);
      expect(await tombstoned('content_grant', grant.token)).toBe(true);
      expect(await tombstoned('share_link', link.token_hash)).toBe(true);
      const versions = await ctx.deps.db.db
        .selectFrom('versions')
        .select('id')
        .where('id', '=', fx.ids.pV2)
        .execute();
      expect(versions).toEqual([]);
    },
  );
});
