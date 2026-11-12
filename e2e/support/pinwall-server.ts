import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface RunningPinwall {
  origin: string;
  /** The one-time link that creates the owner account. A secret: never print it. */
  setupUrl: string;
  dataDir: string;
  stop(): Promise<void>;
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server');
const WEB_DIR = join(REPO_ROOT, 'apps', 'web', 'dist');

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_TAIL_LINES = 40;

/** What the e2e run is currently serving, so the teardown can stop it. */
const running = new Set<RunningPinwall>();

/** The last lines of the server's output, with the one-time setup token blanked. */
function describeTail(lines: string[]): string {
  return lines.join('\n').replace(/token=[^\s"&\\]+/g, 'token=[redacted]');
}

/** The `setup_url` of a JSON log line, or the line's message when it names the listening server. */
function readLogLine(line: string): { setupUrl?: string; listening?: boolean } {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof entry !== 'object' || entry === null) return {};
  const { setup_url: setupUrl, msg } = entry as { setup_url?: unknown; msg?: unknown };
  return {
    ...(typeof setupUrl === 'string' ? { setupUrl } : {}),
    ...(msg === 'listening' ? { listening: true } : {}),
  };
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const done = new Promise<void>((resolveDone) => child.once('exit', () => resolveDone()));
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await done;
  clearTimeout(killer);
}

/**
 * Starts the real server (`main.ts serve`) on `port` with a throwaway data directory and the
 * built SPA. Its public origin is `publicOrigin` (by default `http://localhost:<port>`); `env`
 * adds or overrides settings (the isolation mode, say). Resolves once it listens and has logged
 * the one-time setup link; rejects, with the tail of its output, if it exits or stays silent for
 * 30 seconds. Either way nothing is left running or on disk after a failure.
 */
export async function startPinwall(o: {
  port: number;
  publicOrigin?: string;
  env?: Record<string, string>;
}): Promise<RunningPinwall> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pinwall-e2e-'));
  const origin = o.publicOrigin ?? `http://localhost:${o.port}`;
  // The run owns its configuration: nothing PINWALL_* from the caller's shell leaks in.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PINWALL_')),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'serve'], {
    cwd: SERVER_DIR,
    env: {
      ...inherited,
      PINWALL_DATA_DIR: dataDir,
      PINWALL_WEB_DIR: WEB_DIR,
      PINWALL_PORT: String(o.port),
      // Loopback only: no firewall prompt, and nothing else on the network can reach the run.
      PINWALL_HOST: '127.0.0.1',
      PINWALL_PUBLIC_ORIGIN: origin,
      PINWALL_METRICS_PORT: '0',
      ...o.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // If this process dies without its teardown, the server must not outlive it.
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);

  const tail: string[] = [];
  const remember = (line: string) => {
    tail.push(line);
    if (tail.length > LOG_TAIL_LINES) tail.shift();
  };

  let self: RunningPinwall | null = null;
  const stop = async () => {
    process.off('exit', killOnExit);
    await terminate(child);
    await rm(dataDir, { recursive: true, force: true });
    if (self !== null) running.delete(self);
  };

  try {
    const setupUrl = await new Promise<string>((resolveUrl, reject) => {
      let url: string | undefined;
      let listening = false;
      const timer = setTimeout(
        () => reject(new Error(`Pinwall did not start within ${START_TIMEOUT_MS / 1000} s`)),
        START_TIMEOUT_MS,
      );
      const ready = () => {
        if (url === undefined || !listening) return;
        clearTimeout(timer);
        resolveUrl(url);
      };
      createInterface({ input: child.stdout }).on('line', (line) => {
        remember(line);
        const seen = readLogLine(line);
        if (seen.setupUrl !== undefined) url = seen.setupUrl;
        if (seen.listening) listening = true;
        ready();
      });
      createInterface({ input: child.stderr }).on('line', remember);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Pinwall exited before it was ready (${signal ?? `code ${code}`})`));
      });
    });
    self = { origin, setupUrl, dataDir, stop };
    running.add(self);
    return self;
  } catch (error) {
    await stop();
    throw new Error(
      `${(error as Error).message}\n--- server output (tail) ---\n${describeTail(tail)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Stops every server `startPinwall` started and removes their data directories; safe to call
 * twice.
 */
export async function stopPinwall(): Promise<void> {
  await Promise.all([...running].map((server) => server.stop()));
}
