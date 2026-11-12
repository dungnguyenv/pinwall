import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, onTestFinished, test } from 'vitest';
import { IDP_REFRESH_TOKEN_PURPOSE } from '../../src/auth/oidc/users.ts';
import { BACKUP_LEASE } from '../../src/domain/blobs.ts';
import { deleteVersion } from '../../src/domain/deletion.ts';
import { deriveKey, encryptString } from '../../src/lib/crypto.ts';
import { t } from '../../src/lib/i18n.ts';
import { restoreBackup } from '../../src/ops/backup/restore.ts';
import { PINWALL_VERSION } from '../../src/version.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import {
  backupToBuffer,
  dumpLogical,
  readArchive,
  rowCounts,
  type Seeded,
  seedInstallation,
  storageCombos,
  storageContext,
} from '../helpers/backup.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

/** The blob key of the seeded 5 MB image: its SHA-256. */
function photoKey(seed: Seeded): string {
  const photo = seed.files['img/photo.bin'];
  if (photo === undefined) throw new Error('the seed has no image');
  return createHash('sha256').update(photo).digest('hex');
}

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

/** Each of these starts a Node process that compiles the server from source: allow for it. */
const CLI_TIMEOUT_MS = 90_000;

interface Run {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** The command line that runs `pinwall <args>` from source. */
const pinwallCommand = (args: string[]) => [
  process.execPath,
  '--import',
  'tsx',
  'src/main.ts',
  ...args,
];

/**
 * Runs `pinwall <args>` from source with only the given environment (plus PATH and HOME), feeds
 * `stdin` to it when given, and resolves once the process has exited and its output has ended.
 */
function pinwall(
  args: string[],
  env: Record<string, string>,
  stdin?: Buffer,
): { child: ReturnType<typeof spawn>; done: Promise<Run> } {
  const [command = '', ...commandArgs] = pinwallCommand(args);
  return run(command, commandArgs, env, stdin);
}

/**
 * Runs `pinwall <args>` as `pinwall()` does, but with its standard output and error on a
 * terminal, as `docker exec -t` gives them: a pseudo-terminal from `script`. What the terminal
 * shows, both streams together, arrives as `stdout`.
 */
function pinwallOnTerminal(args: string[], env: Record<string, string>): Promise<Run> {
  const command = pinwallCommand(args);
  // BSD script (macOS) takes the command as arguments, util-linux script as one shell line.
  const quoted = command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
  const scriptArgs =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-q', '-e', '-c', quoted, '/dev/null'];
  return run('script', scriptArgs, env).done;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  stdin?: Buffer,
): { child: ReturnType<typeof spawn>; done: Promise<Run> } {
  const child = spawn(command, args, {
    cwd: serverDir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  if (stdin !== undefined && child.stdin) {
    // A command that refuses before reading its input closes the pipe: not a test failure.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  const done = new Promise<Run>((resolve) =>
    child.once('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }),
    ),
  );
  onTestFinished(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { child, done };
}

/** The JSON log lines of a stream. */
function logLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The environment that points a `pinwall` process at the installation `ctx` opened. */
function envOf(ctx: TestContext): Record<string, string> {
  const { dataDir, database, storage, secretKey } = ctx.deps.config;
  const env: Record<string, string> = { PINWALL_DATA_DIR: dataDir };
  if (database.kind === 'postgres') {
    env.PINWALL_DATABASE_URL = database.url;
    env.PINWALL_SECRET_KEY = secretKey?.toString('hex') ?? '';
  }
  if (storage.kind === 's3') {
    Object.assign(env, {
      PINWALL_STORAGE: 's3',
      PINWALL_S3_BUCKET: storage.bucket,
      PINWALL_S3_ENDPOINT: storage.endpoint ?? '',
      PINWALL_S3_ACCESS_KEY_ID: storage.accessKeyId ?? '',
      PINWALL_S3_SECRET_ACCESS_KEY: storage.secretAccessKey ?? '',
      PINWALL_S3_FORCE_PATH_STYLE: String(storage.forcePathStyle),
      PINWALL_S3_PREFIX: storage.prefix,
    });
  }
  return env;
}

/** A SQLite installation in a data directory that outlives the context, removed after the test. */
async function sqliteInstallation(): Promise<{ ctx: TestContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pinwall-backup-cli-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const ctx = await createTestContext({ env: { PINWALL_DATA_DIR: dir } });
  onTestFinished(() => ctx.close());
  return { ctx, dir };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** A seeded installation on `combo`, closed after the test. */
async function seeded(combo: (typeof storageCombos)[number]) {
  const ctx = await storageContext(combo);
  onTestFinished(() => ctx.close());
  return { ctx, seed: await seedInstallation(ctx) };
}

describe.each(storageCombos)('on %s', (combo) => {
  test(
    'backup --out - writes only the archive to stdout',
    async () => {
      const { ctx, seed } = await seeded(combo);

      const run = await pinwall(['backup', '--out', '-'], envOf(ctx)).done;

      expect(run.code).toBe(0);
      const entries = await readArchive(run.stdout);
      expect(entries[0]?.name).toBe('manifest.json');
      expect(entries.map((e) => e.name)).toContain(`blobs/${photoKey(seed)}`);
      // Nothing but tar bytes: a log line on stdout would corrupt the archive.
      expect(run.stdout.includes('{"level"')).toBe(false);
      const complete = logLines(run.stderr).find((line) => line.msg === 'backup complete');
      const manifest = JSON.parse(entries[0]?.data.toString('utf8') ?? '{}') as {
        tables: Record<string, { rows: number }>;
        blobs: { count: number; bytes: number };
      };
      expect(complete).toMatchObject({
        level: 'info',
        rows: Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0),
        blobs: manifest.blobs.count,
        bytes: manifest.blobs.bytes,
      });
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'restore --in - restores into a fresh installation',
    async () => {
      const source = await seeded('sqlite+local');
      const { buf } = await backupToBuffer(source.ctx.deps);
      const target = await storageContext(combo);
      onTestFinished(() => target.close());

      const run = await pinwall(['restore', '--in', '-'], envOf(target), buf).done;

      expect(run.code).toBe(0);
      expect(run.stdout.toString('utf8')).toBe('');
      expect(logLines(run.stderr).find((line) => line.msg === 'restore complete')).toMatchObject({
        level: 'info',
        blobs: expect.any(Number),
        bytes: expect.any(Number),
        rows: expect.any(Number),
        warnings: [],
      });
      expect(await dumpLogical(target.deps)).toEqual(await dumpLogical(source.ctx.deps));
    },
    CLI_TIMEOUT_MS,
  );
});

describe('backup --out <file>', () => {
  test(
    'writes atomically and never overwrites',
    async () => {
      const { ctx, dir } = await sqliteInstallation();
      await seedInstallation(ctx);
      const file = join(dir, 'pinwall.backup.tar');

      const first = await pinwall(['backup', '--out', file], envOf(ctx)).done;
      expect(first.code).toBe(0);
      expect(first.stdout.length).toBe(0);
      expect(await exists(`${file}.partial`)).toBe(false);
      const archive = await readFile(file);
      expect((await readArchive(archive))[0]?.name).toBe('manifest.json');
      expect(logLines(first.stderr).some((line) => line.msg === 'backup complete')).toBe(true);

      const second = await pinwall(['backup', '--out', file], envOf(ctx)).done;
      expect(second.code).toBe(1);
      expect(second.stderr).toMatch(/^Backup failed: .*already exists/m);
      expect(await readFile(file)).toEqual(archive);
      expect(await exists(`${file}.partial`)).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'leaves a partial file from an earlier run alone',
    async () => {
      const { ctx, dir } = await sqliteInstallation();
      const file = join(dir, 'pinwall.backup.tar');
      await writeFile(`${file}.partial`, 'from a run that was killed');

      const run = await pinwall(['backup', '--out', file], envOf(ctx)).done;

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^Backup failed: .*pinwall\.backup\.tar\.partial already exists/m);
      expect(await readFile(`${file}.partial`, 'utf8')).toBe('from a run that was killed');
      expect(await exists(file)).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'a failed backup leaves neither the file nor its partial',
    async () => {
      const { ctx, dir } = await sqliteInstallation();
      const seed = await seedInstallation(ctx);
      const photo = photoKey(seed);
      const { storage } = ctx.deps.config;
      if (storage.kind !== 'local') throw new Error('expected local storage');
      await writeFile(
        join(storage.dir, photo.slice(0, 2), photo.slice(2, 4), photo),
        randomBytes(5_000_000),
      );
      const file = join(dir, 'pinwall.backup.tar');

      const toFile = await pinwall(['backup', '--out', file], envOf(ctx)).done;
      expect(toFile.code).toBe(1);
      expect(toFile.stderr).toContain(`Backup failed: ${t('backup.blobBad', { sha: photo })}`);
      expect(await exists(file)).toBe(false);
      expect(await exists(`${file}.partial`)).toBe(false);
      // The lease is free again: the failure did not leave the installation locked.
      expect(await ctx.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);

      const toStdout = await pinwall(['backup', '--out', '-'], envOf(ctx)).done;
      expect(toStdout.code).toBe(1);
      expect(toStdout.stderr).toContain(`Backup failed: ${t('backup.blobBad', { sha: photo })}`);
    },
    CLI_TIMEOUT_MS,
  );
});

test(
  'backup --out - refuses a terminal, as tar does',
  async () => {
    const { ctx } = await sqliteInstallation();
    await seedInstallation(ctx);

    const run = await pinwallOnTerminal(['backup', '--out', '-'], envOf(ctx));

    expect(run.code).toBe(1);
    const shown = run.stdout.toString('utf8');
    expect(shown).toContain(`Backup failed: ${t('backup.outTerminal')}`);
    // Not a byte of the archive: its first entry is the manifest.
    expect(shown).not.toContain('manifest.json');
    expect(await ctx.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
  },
  CLI_TIMEOUT_MS,
);

describe('restore', () => {
  test(
    '--in <file> restores into a fresh data directory',
    async () => {
      const source = await seeded('sqlite+local');
      const { buf } = await backupToBuffer(source.ctx.deps);
      const target = await sqliteInstallation();
      const file = join(target.dir, 'in.tar');
      await writeFile(file, buf);

      const run = await pinwall(['restore', '--in', file], envOf(target.ctx)).done;

      expect(run.code).toBe(0);
      expect(await dumpLogical(target.ctx.deps)).toEqual(await dumpLogical(source.ctx.deps));
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'a warning is logged and also printed as plain text on stderr',
    async () => {
      const key = randomBytes(32).toString('hex');
      const origin = await storageContext('sqlite+local', { PINWALL_SECRET_KEY: key });
      onTestFinished(() => origin.close());
      const sso = await createSignedInUser(origin, { kind: 'oidc', name: 'Linh' });
      await origin.deps.db.db
        .updateTable('users')
        .set({
          idp_refresh_token: encryptString(
            deriveKey(Buffer.from(key, 'hex'), IDP_REFRESH_TOKEN_PURPOSE),
            'rt',
          ),
        })
        .where('id', '=', sso.user.id)
        .execute();
      const { buf } = await backupToBuffer(origin.deps);
      // The target generates a key of its own, so the backup's key is not the one in use.
      const target = await sqliteInstallation();

      const run = await pinwall(['restore', '--in', '-'], envOf(target.ctx), buf).done;

      expect(run.code).toBe(0);
      const warning = t('restore.keyChanged', { count: 1 });
      const lines = logLines(run.stderr);
      expect(lines).toContainEqual(expect.objectContaining({ level: 'warn', msg: warning }));
      expect(lines.find((line) => line.msg === 'restore complete')).toMatchObject({
        warnings: [warning],
      });
      expect(run.stderr.split('\n')).toContain(warning);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'into a non-empty data directory exits 1 with the reason',
    async () => {
      const { ctx } = await sqliteInstallation();
      await seedInstallation(ctx);
      const { buf } = await backupToBuffer(ctx.deps);
      const before = await rowCounts(ctx.deps);

      const run = await pinwall(['restore', '--in', '-'], envOf(ctx), buf).done;

      expect(run.code).toBe(1);
      const failure = run.stderr.split('\n').find((line) => line.startsWith('Restore failed: '));
      expect(failure).toMatch(
        /^Restore failed: The target is not empty \(.+\)\. Restore into a new/,
      );
      expect(run.stdout.length).toBe(0);
      expect(await rowCounts(ctx.deps)).toEqual(before);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'a damaged archive exits 1 and leaves the target empty',
    async () => {
      const target = await sqliteInstallation();

      const run = await pinwall(
        ['restore', '--in', '-'],
        envOf(target.ctx),
        Buffer.from('not a tar'),
      ).done;

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^Restore failed: /m);
      expect(Object.values(await rowCounts(target.ctx.deps)).every((n) => n === 0)).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'a missing input file exits 1',
    async () => {
      const target = await sqliteInstallation();

      const run = await pinwall(
        ['restore', '--in', join(target.dir, 'nothing.tar')],
        envOf(target.ctx),
      ).done;

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^Restore failed: .*nothing\.tar/m);
    },
    CLI_TIMEOUT_MS,
  );
});

test(
  'a backup next to a busy server is consistent',
  async () => {
    const { ctx } = await sqliteInstallation();
    const seed = await seedInstallation(ctx);
    const owner = await ctx.deps.db.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    const auth = { user: owner, via: 'session' as const };

    const { child, done } = pinwall(['backup', '--out', '-'], envOf(ctx));
    // The lease is taken before the snapshot: from here on the backup is under way.
    const started = Date.now();
    while (!(await ctx.deps.leases.isHeld(BACKUP_LEASE)) && child.exitCode === null) {
      if (Date.now() - started > 30_000) throw new Error('the backup never took its lease');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Publish 20 versions and delete 5 of them (each time the newest, so the current version
    // moves back) while it runs.
    let current = (
      await ctx.deps.db.db
        .selectFrom('artifacts')
        .select('current_version_id')
        .where('id', '=', seed.artifactId)
        .executeTakeFirstOrThrow()
    ).current_version_id;
    let deleted = 0;
    for (let i = 0; i < 20; i++) {
      const expectedVersionId = current ?? '';
      const published = await publishFiles(
        ctx,
        owner,
        { 'index.html': `<p>Bản ${i} ${randomBytes(8).toString('hex')}</p>` },
        { kind: 'new_version', artifactId: seed.artifactId, expectedVersionId },
      );
      current = published.version.id;
      if (i % 4 === 3) {
        const after = await deleteVersion(
          ctx.deps,
          auth,
          seed.artifactId,
          published.version.number,
        );
        current = after.currentVersionId;
        deleted++;
      }
    }
    expect(deleted).toBe(5);

    const run = await done;
    expect(run.code).toBe(0);

    const target = await storageContext('sqlite+local');
    onTestFinished(() => target.close());
    const summary = await restoreBackup(target.deps, Readable.from(run.stdout));
    expect(summary.warnings).toEqual([]);
    const orphaned = await target.deps.db.db
      .selectFrom('artifacts')
      .select('id')
      .where('current_version_id', 'is not', null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('versions')
              .select('versions.id')
              .whereRef('versions.id', '=', 'artifacts.current_version_id'),
          ),
        ),
      )
      .execute();
    expect(orphaned).toEqual([]);
    const restored = await target.deps.db.db
      .selectFrom('artifacts')
      .select('current_version_id')
      .where('id', '=', seed.artifactId)
      .executeTakeFirstOrThrow();
    expect(restored.current_version_id).not.toBeNull();
  },
  CLI_TIMEOUT_MS,
);

describe('the command line', () => {
  test.each([
    ['backup without --out', ['backup']],
    ['--out without a value', ['backup', '--out']],
    ['restore without --in', ['restore']],
    ['--in without a value', ['restore', '--in']],
    ['--in on backup', ['backup', '--in', 'x']],
    ['--out on restore', ['restore', '--out', 'x', '--in', 'y']],
    ['--out on serve', ['serve', '--out', 'x']],
    ['--in on migrate', ['migrate', '--in', 'x']],
    ['--out on version', ['version', '--out', 'x']],
    ['both options on backup', ['backup', '--out', 'x', '--in', 'y']],
  ])(
    'usage error: %s exits 2',
    async (_name, args) => {
      const run = await pinwall(args, {}).done;

      expect(run.code).toBe(2);
      expect(run.stderr).toContain('Usage: pinwall');
      expect(run.stdout.length).toBe(0);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'the usage text lists backup, restore and version',
    async () => {
      const run = await pinwall(['--help'], {}).done;

      expect(run.code).toBe(0);
      const text = run.stdout.toString('utf8');
      expect(text).toContain('backup --out <file|->');
      expect(text).toContain('restore --in <file|->');
      expect(text).toMatch(/^ {2}version {17}Print the Pinwall version$/m);
    },
    CLI_TIMEOUT_MS,
  );

  test.each([['version'], ['--version'], ['-v']])(
    '%s prints the version',
    async (arg) => {
      // No configuration at all: the version needs none.
      const run = await pinwall([arg], {}).done;

      expect(run.code).toBe(0);
      expect(run.stdout.toString('utf8')).toBe(`${PINWALL_VERSION}\n`);
      expect(run.stderr).toBe('');
    },
    CLI_TIMEOUT_MS,
  );

  test(
    'a configuration error in backup or restore exits 2',
    async () => {
      const [backup, restore] = await Promise.all([
        pinwall(['backup', '--out', '-'], { PINWALL_PORT: 'eighty' }).done,
        pinwall(['restore', '--in', '-'], { PINWALL_PORT: 'eighty' }, Buffer.alloc(0)).done,
      ]);

      for (const run of [backup, restore]) {
        expect(run.code).toBe(2);
        expect(run.stderr).toContain('PINWALL_PORT: must be a whole number');
        expect(run.stdout.length).toBe(0);
      }
    },
    CLI_TIMEOUT_MS,
  );
});
