import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createGrant } from '../../src/content/grants.ts';
import { endVersionGrants } from '../../src/domain/moderation.ts';
import { systemRevokeShareLink } from '../../src/domain/shares.ts';
import { lockProject, SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects, untilWaitingOnALock } from '../helpers/db.ts';
import { type SpacesFixture, spacesFixture } from '../spaces/fixture.ts';
import { moderationContext } from './helpers.ts';

/**
 * The system's writes in personal mode take the project after the artifact, as every write does,
 * so a membership change in the project (which locks it for update) and they take turns.
 */
describe.runIf(dialects.includes('postgres'))('moderation writes on Postgres', () => {
  let ctx: TestContext;
  let fx: SpacesFixture;
  beforeAll(async () => {
    // A transaction held open, the write that waits on it, and the query that watches them.
    ctx = await moderationContext('postgres', 'personal', { PINWALL_DATABASE_POOL_SIZE: '6' });
  });
  beforeEach(async () => {
    fx = await spacesFixture(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Starts `write` while a membership change holds project P (up to its commit), and says whether
   * `write` had finished before that change committed, and how it ended: what it returned, or
   * what it threw.
   */
  async function duringMembershipChange(
    write: () => Promise<unknown>,
  ): Promise<{ settledFirst: boolean; outcome: unknown }> {
    const { db } = ctx.deps.db;
    let held = () => {};
    const locked = new Promise<void>((resolve) => {
      held = resolve;
    });
    let commit = () => {};
    const release = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const change = db.transaction().execute(async (trx) => {
      await lockProject(trx, 'postgres', fx.ids.P);
      held();
      await release;
    });
    try {
      await Promise.race([locked, change]);
      let settled = false;
      const outcome = write().then(
        (value) => value,
        (err: unknown) => err,
      );
      void outcome.then(() => {
        settled = true;
      });
      await untilWaitingOnALock(db, outcome);
      const settledFirst = settled;
      commit();
      await change;
      return { settledFirst, outcome: await outcome };
    } finally {
      commit();
    }
  }

  test('revoking a link waits for a membership change in its project, then goes through', async () => {
    const grant = await createGrant(ctx.deps, {
      versionId: fx.ids.pV2,
      mode: 'raw',
      user: null,
      shareLinkId: fx.ids.pLink,
    });
    const { settledFirst, outcome } = await duringMembershipChange(() =>
      systemRevokeShareLink(ctx.deps, SYSTEM_SCOPE, fx.ids.pLink),
    );
    expect(settledFirst, 'the revoke waited for the membership change').toBe(false);
    expect(outcome).toBeUndefined();
    const link = await ctx.deps.db.db
      .selectFrom('share_links')
      .select('revoked_at')
      .where('id', '=', fx.ids.pLink)
      .executeTakeFirstOrThrow();
    expect(link.revoked_at).not.toBeNull();
    const left = await ctx.deps.db.db
      .selectFrom('content_grants')
      .select('token')
      .where('token', '=', grant.token)
      .execute();
    expect(left).toEqual([]);
  });

  test('ending the grants of a version waits for a membership change in its project, then goes through', async () => {
    await createGrant(ctx.deps, {
      versionId: fx.ids.pV2,
      mode: 'review',
      user: fx.people.A.user,
    });
    const { settledFirst, outcome } = await duringMembershipChange(() =>
      endVersionGrants(ctx.deps, SYSTEM_SCOPE, fx.ids.pV2),
    );
    expect(settledFirst, 'the end waited for the membership change').toBe(false);
    expect(outcome).toBe(1);
  });
});
