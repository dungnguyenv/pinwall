import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { connectDb } from '../src/db/connect.ts';
import { closeDeps } from '../src/deps.ts';
import { createTestContext } from './helpers/context.ts';
import { dialects } from './helpers/db.ts';

describe.each(dialects)('createDeps on %s', (dialect) => {
  test('migrates the database and puts the instance secret into the config', async () => {
    const ctx = await createTestContext({ dialect });
    onTestFinished(() => ctx.close());

    const tables = await ctx.deps.db.db.introspection.getTables();
    expect(tables.map((table) => table.name)).toContain('users');
    const key = ctx.deps.config.secretKey;
    expect(key?.length).toBe(32);
    expect(await readFile(join(ctx.deps.config.dataDir, 'secret.key'))).toEqual(key);
  });

  test('logs what an event handler throws', async () => {
    const ctx = await createTestContext({ dialect });
    onTestFinished(() => ctx.close());
    const logged = vi.spyOn(ctx.deps.logger, 'error');
    const boom = new Error('handler failed');

    ctx.deps.events.subscribe('artifact:1', () => {
      throw boom;
    });
    ctx.deps.events.publish('artifact:1', { type: 'comment.created' });

    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, topic: 'artifact:1' }),
      expect.any(String),
    );
  });

  test('close is idempotent end to end', async () => {
    const ctx = await createTestContext({ dialect });
    await ctx.deps.db.close();
    await ctx.close();
    await ctx.close();
  });
});

test('closeDeps stops the scheduler before it closes the database', async () => {
  const ctx = await createTestContext();
  onTestFinished(() => ctx.close());
  const { config, scheduler, leases } = ctx.deps;
  let ran = false;
  scheduler.every('probe', 10, async () => {
    ran = true;
  });
  await vi.waitFor(() => expect(ran).toBe(true));
  expect(await leases.isHeld('job:probe')).toBe(true);

  await closeDeps(ctx.deps);

  // Stopping released the lease, which needs the database still open.
  if (config.database.kind !== 'sqlite') throw new Error('expected sqlite');
  const reopened = await connectDb(config.database);
  onTestFinished(() => reopened.close());
  const rows = await reopened.db.selectFrom('leases').selectAll().execute();
  expect(rows).toEqual([]);
});
