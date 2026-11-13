import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { defaultProjectFor, scopeForUser } from '../../src/domain/spaces.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { spacesFixture } from '../spaces/fixture.ts';
import { moderationContext } from './helpers.ts';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

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
  return { output, exited };
}

/** How the command's report names a user. */
const label = (user: UserRow) => `${user.email} (${user.id})`;

describe.each(dialects)('pinwall transfer on %s', (dialect) => {
  let ctx: TestContext;
  let dataDir: string;
  /** What the command needs to reach the context's database. */
  let env: Record<string, string>;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pinwall-transfer-'));
    // SQLite keeps its key in the data dir; Postgres needs it given, to the command as well.
    const keyed: Record<string, string> =
      dialect === 'postgres' ? { PINWALL_SECRET_KEY: randomBytes(32).toString('hex') } : {};
    ctx = await moderationContext(dialect, 'personal', { PINWALL_DATA_DIR: dataDir, ...keyed });
    const { database } = ctx.deps.config;
    env = { PINWALL_DATA_DIR: dataDir, PINWALL_VISIBILITY: 'personal', ...keyed };
    if (database.kind === 'postgres') env.PINWALL_DATABASE_URL = database.url;
  });
  afterAll(async () => {
    await ctx?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /** Every project and its owner, by id. */
  const owners = async () =>
    ctx.deps.db.db.selectFrom('projects').select(['id', 'owner_id']).orderBy('id').execute();

  test('transfer moves the projects and prints what it did', async () => {
    const fx = await spacesFixture(ctx);
    const { A, V } = fx.people;
    const own = (user: UserRow) => defaultProjectFor(ctx.deps, scopeForUser(ctx.deps, user));
    const aDefault = await own(A.user);
    await own(V.user);

    const { output, exited } = pinwall(
      ['transfer', '--from', A.user.id, '--to', (V.user.email ?? '').toUpperCase()],
      env,
    );
    expect(await exited, output.stderr).toBe(0);
    expect(output.stdout).toContain(
      t('transfer.done', {
        projects: 3,
        artifacts: 3,
        from: label(A.user),
        to: label(V.user),
        links: 2,
        memberships: 1,
      }),
    );
    expect(output.stdout).toContain(
      t('transfer.renamed', { from: label(A.user), name: 'Default (from A)' }),
    );

    const after = new Map((await owners()).map((row) => [row.id, row.owner_id]));
    for (const id of [fx.ids.P, fx.ids.Q, aDefault.id]) expect(after.get(id)).toBe(V.user.id);
    expect([...after.values()]).not.toContain(A.user.id);
  }, 30_000);

  test('an email shared by two accounts is refused with both ids, and nothing moves', async () => {
    const fx = await spacesFixture(ctx);
    // On the owner's own instance, the local owner account and their OIDC account share an email.
    const owner = await createSignedInUser(ctx, { kind: 'owner' });
    const oidc = await createSignedInUser(ctx, { kind: 'oidc' });
    const ids = [owner.user.id, oidc.user.id].sort();
    await ctx.deps.db.db
      .updateTable('users')
      .set({ email: 'dn@example.test' })
      .where('id', 'in', ids)
      .execute();
    const before = await owners();

    const ref = 'DN@example.test';
    const refused = pinwall(['transfer', '--from', fx.people.A.user.id, '--to', ref], env);
    expect(await refused.exited, refused.output.stdout).toBe(1);
    const message = t('transfer.ambiguous', { ref, count: 2, ids: ids.join(', ') });
    expect(refused.output.stderr).toContain(t('transfer.failed', { message }));
    for (const id of ids) expect(refused.output.stderr).toContain(id);

    const unknown = pinwall(
      ['transfer', '--from', 'nobody@example.test', '--to', fx.people.V.user.id],
      env,
    );
    expect(await unknown.exited, unknown.output.stdout).toBe(1);
    expect(unknown.output.stderr).toContain(
      t('transfer.failed', { message: t('transfer.noUser', { ref: 'nobody@example.test' }) }),
    );
    expect(await owners()).toEqual(before);
  }, 30_000);
});

test('transfer needs --from and --to, and they belong to it', async () => {
  const needs = 'transfer needs --from <id|email> and --to <id|email>';
  const cases: [string[], string][] = [
    [['transfer'], needs],
    [['transfer', '--from', 'x'], needs],
    [['transfer', '--to', 'x'], needs],
    [['transfer', '--from', '', '--to', 'x'], needs],
    [['serve', '--from', 'x'], '--from belongs to the transfer command'],
    [['migrate', '--to', 'x'], '--to belongs to the transfer command'],
  ];
  for (const [args, message] of cases) {
    const { output, exited } = pinwall(args, {});
    expect(await exited, args.join(' ')).toBe(2);
    expect(output.stderr, args.join(' ')).toContain(message);
  }
  const { output, exited } = pinwall(['help'], {});
  expect(await exited).toBe(0);
  expect(output.stdout).toContain(
    'transfer --from <user> --to <user>  Move every project of one user to another (id or email)',
  );
}, 60_000);
