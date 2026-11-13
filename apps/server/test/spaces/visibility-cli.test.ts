import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { connectDb } from '../../src/db/connect.ts';
import { migrateToLatest } from '../../src/db/migrate.ts';
import { LAST_VISIBILITY, writeSetting } from '../../src/domain/spaces-startup.ts';
import { t } from '../../src/lib/i18n.ts';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const T = 1_762_000_000_000;

/** Starts `pinwall <args>` from source with only the given environment (plus PATH and HOME). */
function pinwall(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: serverDir,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  onTestFinished(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { child, output, exited };
}

/** The first JSON log line on stdout with message `msg`. */
async function waitForLog(child: ChildProcess, output: { stdout: string }, msg: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = output.stdout
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((entry) => entry.msg === msg);
    if (line) return line;
    if (child.exitCode !== null) throw new Error(`exited before logging "${msg}"`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for "${msg}"`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A data dir whose database was last run in personal mode, with two people owning a project. */
async function personalDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pinwall-visibility-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const h = await connectDb({ kind: 'sqlite', path: join(dir, 'pinwall.db') });
  try {
    await migrateToLatest(h);
    const owners = ['usr_a', 'usr_b'];
    await h.db
      .insertInto('users')
      .values(
        owners.map((id) => ({
          id,
          kind: 'oidc' as const,
          email: `${id}@example.test`,
          email_verified: 1 as const,
          idp_role: 'member' as const,
          oidc_issuer: 'https://idp.example.test',
          oidc_subject: id,
          created_at: T,
        })),
      )
      .execute();
    await h.db
      .insertInto('projects')
      .values(
        owners.map((id) => ({
          id: `prj_${id}`,
          name: id,
          instructions: '',
          is_default: 0 as const,
          archived_at: null,
          created_by: id,
          created_at: T,
          updated_at: T,
          owner_id: id,
        })),
      )
      .execute();
    await writeSetting(h.db, LAST_VISIBILITY, 'personal', T);
  } finally {
    await h.close();
  }
  return dir;
}

const serveEnv = (dataDir: string) => ({
  PINWALL_DATA_DIR: dataDir,
  PINWALL_HOST: '127.0.0.1',
  PINWALL_PORT: '0',
  PINWALL_METRICS_PORT: '0',
  PINWALL_VISIBILITY: 'team',
});

test('serve refuses team after personal and names the confirmation', async () => {
  const dataDir = await personalDataDir();
  const { output, exited } = pinwall(['serve'], serveEnv(dataDir));
  expect(await exited).toBe(2);
  expect(output.stderr).toContain('pinwall visibility team --confirm');
  expect(output.stdout).not.toContain('listening');
}, 30_000);

test('visibility team --confirm records team, and serve then starts', async () => {
  const dataDir = await personalDataDir();
  const confirm = pinwall(['visibility', 'team', '--confirm'], { PINWALL_DATA_DIR: dataDir });
  expect(await confirm.exited).toBe(0);
  expect(confirm.output.stdout).toContain(t('spaces.guard.confirmed', { owners: 2 }));

  const { child, output, exited } = pinwall(['serve'], serveEnv(dataDir));
  await waitForLog(child, output, 'listening');
  child.kill('SIGTERM');
  expect(await exited).toBe(0);
}, 40_000);

test('visibility needs team and --confirm', async () => {
  const cases: [string[], string][] = [
    [['visibility'], 'visibility needs "team"'],
    [['visibility', 'personal', '--confirm'], 'visibility needs "team"'],
    [['visibility', 'team'], 'visibility team needs --confirm'],
    [['serve', '--confirm'], '--confirm belongs to the visibility command'],
  ];
  for (const [args, message] of cases) {
    const { output, exited } = pinwall(args, {});
    expect(await exited, args.join(' ')).toBe(2);
    expect(output.stderr, args.join(' ')).toContain(message);
  }
}, 30_000);
