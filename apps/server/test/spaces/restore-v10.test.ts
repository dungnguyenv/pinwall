import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest';
import { DEFAULT_PROJECT_ID, ensureDefaultProject, getProject } from '../../src/domain/projects.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { RestoreError, restoreBackup } from '../../src/ops/backup/restore.ts';
import {
  backupToBuffer,
  dumpLogical,
  rewriteArchive,
  seedInstallation,
} from '../helpers/backup.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { toV10Archive } from './v10-archive.ts';

/** Restores move ~5 MB through two installations, which takes a while under parallel load. */
const RESTORE_TIMEOUT_MS = 60_000;

type Dump = Awaited<ReturnType<typeof dumpLogical>>;

/** `dump` without what `0003_spaces` added: its two tables and its columns. */
function withoutSpaces(dump: Dump): Partial<Dump> {
  const { project_members, instance_settings, ...rest } = dump;
  return {
    ...rest,
    users: rest.users.map((row) => {
      const { share_approved, quota_bytes, quota_artifacts, ...v10 } = row as Record<
        string,
        unknown
      >;
      return v10;
    }),
    projects: rest.projects.map((row) => {
      const { owner_id, ...v10 } = row as Record<string, unknown>;
      return v10;
    }),
  };
}

describe.each(dialects)('restore with spaces on %s', (dialect) => {
  /** A seeded installation and its backup, shared by the tests below; nobody changes it. */
  let src: TestContext;
  let archive: Buffer;

  beforeAll(async () => {
    src = await createTestContext({ dialect });
    await seedInstallation(src);
    archive = (await backupToBuffer(src.deps)).buf;
  }, RESTORE_TIMEOUT_MS);
  afterAll(() => src.close());

  async function target(): Promise<TestContext> {
    const dst = await createTestContext({ dialect });
    onTestFinished(() => dst.close());
    return dst;
  }

  test(
    'a 1.0 archive restores and gets its owners',
    async () => {
      const dst = await target();

      await restoreBackup(dst.deps, Readable.from(await toV10Archive(archive)));

      const { db } = dst.deps.db;
      const owner = await db
        .selectFrom('users')
        .select('id')
        .where('kind', '=', 'owner')
        .executeTakeFirstOrThrow();
      const projects = await db
        .selectFrom('projects')
        .select(['id', 'created_by', 'owner_id'])
        .orderBy('id')
        .execute();
      expect(projects.find((p) => p.id === DEFAULT_PROJECT_ID)).toEqual({
        id: DEFAULT_PROJECT_ID,
        created_by: null,
        owner_id: owner.id,
      });
      expect(projects).toEqual(projects.map((p) => ({ ...p, owner_id: p.created_by ?? owner.id })));

      expect(await db.selectFrom('project_members').selectAll().execute()).toEqual([]);
      expect(await db.selectFrom('instance_settings').selectAll().execute()).toEqual([]);
      const users = await db
        .selectFrom('users')
        .select(['share_approved', 'quota_bytes', 'quota_artifacts'])
        .execute();
      expect(users.length).toBeGreaterThan(1);
      for (const user of users) {
        expect(user).toEqual({ share_approved: 0, quota_bytes: null, quota_artifacts: null });
      }
      expect(withoutSpaces(await dumpLogical(dst.deps))).toEqual(
        withoutSpaces(await dumpLogical(src.deps)),
      );
    },
    RESTORE_TIMEOUT_MS,
  );

  test(
    'a 1.0 archive cannot carry a table newer than it',
    async () => {
      const dst = await target();
      const v10 = await toV10Archive(archive);
      const extra = { name: 'tables/project_members.jsonl', data: Buffer.alloc(0) };

      const restoring = restoreBackup(
        dst.deps,
        Readable.from(await rewriteArchive(v10, (e) => e, [extra])),
      );

      await expect(restoring).rejects.toThrow(/unexpected entry "tables\/project_members\.jsonl"/);
      await expect(restoring).rejects.toBeInstanceOf(RestoreError);
    },
    RESTORE_TIMEOUT_MS,
  );

  test.each(['project_members', 'instance_settings'])(
    'an archive that lists 0003_spaces must carry both new tables: %s',
    async (table) => {
      const dst = await target();
      const name = `tables/${table}.jsonl`;
      const lacking = await rewriteArchive(archive, (e) => (e.name === name ? null : e));

      const restoring = restoreBackup(dst.deps, Readable.from(lacking));

      await expect(restoring).rejects.toThrow(new RegExp(`tables/${table}\\.jsonl is missing`));
      await expect(restoring).rejects.toBeInstanceOf(RestoreError);
    },
    RESTORE_TIMEOUT_MS,
  );

  test(
    "a target that has started once takes the archive's settings",
    async () => {
      const dst = await target();
      await ensureDefaultProject(dst.deps);
      await dst.deps.db.db
        .insertInto('instance_settings')
        .values({ key: 'visibility.last', value: 'personal', updated_at: dst.deps.clock.now() })
        .execute();

      await restoreBackup(dst.deps, Readable.from(archive));

      expect(await dst.deps.db.db.selectFrom('instance_settings').selectAll().execute()).toEqual([
        { key: 'visibility.last', value: 'team', updated_at: expect.any(Number) },
      ]);
      // Everything else is the archive's too, owners as they were: an archive made since
      // 0003_spaces is not backfilled again, so the unowned default project stays unowned.
      expect(await dumpLogical(dst.deps)).toEqual(await dumpLogical(src.deps));
      expect(await getProject(dst.deps.db.db, SYSTEM_SCOPE, DEFAULT_PROJECT_ID)).toMatchObject({
        owner_id: null,
      });
    },
    RESTORE_TIMEOUT_MS,
  );
});
