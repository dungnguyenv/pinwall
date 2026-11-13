import { buildApp } from '../../src/app.ts';
import type { RateRule } from '../../src/auth/rate-limits.ts';
import type { Config, Visibility } from '../../src/config/types.ts';
import type { DbDialect } from '../../src/db/connect.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { T } from '../spaces/fixture.ts';

/**
 * An app in `visibility` mode, with `PINWALL_SHARE_LINKS=members` so `spacesFixture` can make its
 * links, and a clock standing at `T` until a test moves it. `env` adds to or replaces those.
 */
export function moderationContext(
  dialect: DbDialect,
  visibility: Visibility,
  env: Record<string, string> = {},
): Promise<TestContext> {
  return createTestContext({
    dialect,
    clock: new FixedClock(T),
    env: { PINWALL_VISIBILITY: visibility, PINWALL_SHARE_LINKS: 'members', ...env },
  });
}

/**
 * The same database and infrastructure under another configuration: a new app over
 * `{ ...deps, config: { ...config, ...patch } }`. `close` stays ctx's, so closing either closes
 * both.
 */
export function contextWith(ctx: TestContext, patch: Partial<Config>): TestContext {
  const deps = { ...ctx.deps, config: { ...ctx.deps.config, ...patch } };
  const app = buildApp(deps);
  return {
    app,
    deps,
    request: async (path, init) => {
      const url = /^https?:\/\//.test(path) ? path : new URL(path, deps.config.publicOrigin).href;
      return app.request(url, init);
    },
    close: ctx.close,
  };
}

/** Approves `userId` to expose content (`users.share_approved`), or withdraws it. */
export async function approve(ctx: TestContext, userId: string, approved = true): Promise<void> {
  await ctx.deps.db.db
    .updateTable('users')
    .set({ share_approved: approved ? 1 : 0 })
    .where('id', '=', userId)
    .execute();
}

/**
 * Sets `userId`'s own quota (`users.quota_bytes`, `users.quota_artifacts`), as an admin would: a
 * number replaces the instance's limit for them (0: no limit), null gives the instance's back,
 * and a count left out stays as it is.
 */
export async function setQuota(
  ctx: TestContext,
  userId: string,
  q: { bytes?: number | null; artifacts?: number | null },
): Promise<void> {
  const changes: { quota_bytes?: number | null; quota_artifacts?: number | null } = {};
  if (q.bytes !== undefined) changes.quota_bytes = q.bytes;
  if (q.artifacts !== undefined) changes.quota_artifacts = q.artifacts;
  if (Object.keys(changes).length === 0) return;
  await ctx.deps.db.db.updateTable('users').set(changes).where('id', '=', userId).execute();
}

/**
 * Uses up `n` attempts of `rule` for `key` (a user id), as `n` requests would, so a test can stand
 * at the edge of a limit without sending hundreds of them.
 */
export async function exhaustRate(
  ctx: TestContext,
  rule: RateRule,
  key: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await ctx.deps.rateLimiter.consume(`${rule.name}:${key}`, rule.limit, rule.windowMs);
  }
}
