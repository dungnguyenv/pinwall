import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TombstoneKind } from '../../src/db/schema.ts';
import { addTombstones, isTombstoned, pruneTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);

describe.each(dialects)('tombstones on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
  });
  afterEach(() => ctx.close());

  const has = (kind: TombstoneKind, key: string) =>
    isTombstoned(ctx.deps.db.db, kind, key, clock.now());

  test('tombstones answer and prune', async () => {
    await addTombstones(
      ctx.deps.db.db,
      [
        { kind: 'artifact', key: 'art_1', expiresAt: null },
        { kind: 'content_grant', key: 'tok', expiresAt: T + 1000 },
      ],
      clock.now(),
    );
    expect(await has('artifact', 'art_1')).toBe(true);
    expect(await has('content_grant', 'tok')).toBe(true);
    // The kind is part of the key.
    expect(await has('share_link', 'art_1')).toBe(false);
    expect(await has('artifact', 'tok')).toBe(false);

    clock.advance(1001);
    expect(await has('content_grant', 'tok')).toBe(false);
    expect(await pruneTombstones(ctx.deps)).toBe(1);
    expect(await has('artifact', 'art_1')).toBe(true);
    expect(await ctx.deps.db.db.selectFrom('tombstones').selectAll().execute()).toEqual([
      { kind: 'artifact', key: 'art_1', deleted_at: T, expires_at: null },
    ]);
  });

  test('a tombstone ends at its expiry millisecond', async () => {
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'share_link', key: 'hash', expiresAt: T + 1000 }],
      clock.now(),
    );
    clock.set(T + 999);
    expect(await has('share_link', 'hash')).toBe(true);
    expect(await pruneTombstones(ctx.deps)).toBe(0);

    clock.set(T + 1000);
    expect(await has('share_link', 'hash')).toBe(false);
    expect(await pruneTombstones(ctx.deps)).toBe(1);
  });

  test('adding a tombstone again keeps the first one', async () => {
    const { db } = ctx.deps.db;
    await addTombstones(db, [{ kind: 'artifact', key: 'art_1', expiresAt: null }], T);
    await addTombstones(
      db,
      [
        { kind: 'artifact', key: 'art_1', expiresAt: T + 5 },
        { kind: 'artifact', key: 'art_1', expiresAt: T + 6 },
      ],
      T + 1,
    );
    expect(await db.selectFrom('tombstones').selectAll().execute()).toEqual([
      { kind: 'artifact', key: 'art_1', deleted_at: T, expires_at: null },
    ]);
  });

  test('adds more rows than one statement carries', async () => {
    const keys = Array.from({ length: 1201 }, (_, i) => `tok_${i}`);
    const rows = keys.map((key) => ({ kind: 'content_grant' as const, key, expiresAt: T + 10 }));
    // The repeat lands in a later chunk than the original.
    await addTombstones(ctx.deps.db.db, [...rows, ...rows.slice(0, 1)], T);
    await addTombstones(ctx.deps.db.db, [], T);

    const count = await ctx.deps.db.db
      .selectFrom('tombstones')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1201);
    expect(await has('content_grant', 'tok_1200')).toBe(true);
  });
});
