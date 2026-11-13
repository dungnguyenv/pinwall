import { buildApp } from '../../src/app.ts';
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
