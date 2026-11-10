import { rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

describe.each(dialects)('health checks on %s', (dialect) => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext({ dialect });
  });
  afterEach(() => ctx.close());

  test('healthz is ok', async () => {
    const r = await ctx.request('/healthz');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  test('readyz checks the database', async () => {
    const ready = await ctx.request('/readyz');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', storage: 'ok' },
    });

    await ctx.deps.db.close();
    const r = await ctx.request('/readyz');
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: 'failed', storage: 'ok' },
    });
  });

  test('readyz checks the blob store', async () => {
    const { storage } = ctx.deps.config;
    if (storage.kind !== 'local') throw new Error('expected local blobs');
    // A file where the blob directory should be: the store can no longer write.
    await rm(storage.dir, { recursive: true, force: true });
    await writeFile(storage.dir, 'not a directory');

    const r = await ctx.request('/readyz');
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: 'ok', storage: 'failed' },
    });
  });

  test('health checks answer JSON to browsers too', async () => {
    const r = await ctx.request('/healthz', { headers: { accept: 'text/html' } });
    expect(r.headers.get('content-type')).toContain('application/json');
  });
});
