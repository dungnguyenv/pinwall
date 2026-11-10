import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { connectDb } from '../src/db/connect.ts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

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

function logLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pinwall-cli-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitForLog(
  child: ChildProcess,
  output: { stdout: string },
  msg: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = logLines(output.stdout).find((entry) => entry.msg === msg);
    if (line) return line;
    if (child.exitCode !== null) throw new Error(`exited before logging "${msg}"`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for "${msg}"`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a configuration error lists every issue on its own line and exits 2', async () => {
  const { output, exited } = pinwall(['serve'], {
    PINWALL_PORT: 'eighty',
    PINWALL_ISOLATION: 'separate',
  });
  expect(await exited).toBe(2);
  const lines = output.stderr.split('\n');
  expect(lines.some((line) => line.includes('PINWALL_PORT: must be a whole number'))).toBe(true);
  expect(lines.some((line) => line.includes('PINWALL_ISOLATION: must be'))).toBe(true);
}, 20_000);

test('an unknown command prints usage and exits 2', async () => {
  const { output, exited } = pinwall(['frobnicate'], {});
  expect(await exited).toBe(2);
  expect(output.stderr).toContain('Usage: pinwall');
}, 20_000);

test('migrate applies the migrations and exits', async () => {
  const dataDir = await tempDataDir();
  const { output, exited } = pinwall(['migrate'], { PINWALL_DATA_DIR: dataDir });
  expect(await exited).toBe(0);
  expect(logLines(output.stdout)).toContainEqual(
    expect.objectContaining({ msg: 'migrated', applied: ['0001_initial'] }),
  );

  const h = await connectDb({ kind: 'sqlite', path: join(dataDir, 'pinwall.db') });
  onTestFinished(() => h.close());
  expect((await h.db.introspection.getTables()).map((table) => table.name)).toContain('users');
}, 20_000);

test('serve listens, answers health checks and stops cleanly on SIGTERM', async () => {
  const dataDir = await tempDataDir();
  const { child, output, exited } = pinwall([], {
    PINWALL_DATA_DIR: dataDir,
    PINWALL_HOST: '127.0.0.1',
    PINWALL_PORT: '0',
    PINWALL_PUBLIC_ORIGIN: 'http://pinwall.example.com',
    PINWALL_ISOLATION: 'content-domain',
    PINWALL_CONTENT_ORIGIN: 'http://content.example.com',
  });

  const listening = await waitForLog(child, output, 'listening');
  expect(listening).toMatchObject({
    level: 'info',
    public_origin: 'http://pinwall.example.com',
    isolation: 'content-domain',
    database: 'sqlite',
    storage: 'local',
  });
  // The shared registrable domain is a configuration warning, logged at start.
  expect(logLines(output.stdout)).toContainEqual(
    expect.objectContaining({ level: 'warn', msg: expect.stringContaining('registrable domain') }),
  );

  const r = await fetch(`http://127.0.0.1:${listening.port}/healthz`);
  expect(await r.json()).toEqual({ status: 'ok' });

  child.kill('SIGTERM');
  expect(await exited).toBe(0);
  expect(logLines(output.stdout)).toContainEqual(expect.objectContaining({ msg: 'stopped' }));
}, 30_000);
