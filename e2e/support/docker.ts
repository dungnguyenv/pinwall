import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/*
 * The acceptance suite's handle on Docker: the built image run the way the README says, and the
 * Compose examples brought up as they ship. Every container, volume and Compose project is named
 * by the caller (`pinwall-acc-*`) and removed by name; nothing is ever pruned.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** What a command run in a container returned. */
export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface Container {
  name: string;
  /** The address the browser and Node use: `http://localhost:<port>`, or the configured origin. */
  origin: string;
  /** Everything the container wrote, stdout then stderr. */
  logs(): Promise<string>;
  /** `docker exec` (with `-i` when there is `stdin`, never `-t`, which would rewrite bytes). */
  exec(args: string[], o?: { stdin?: Buffer }): Promise<ExecResult>;
  /** Stops the server with SIGTERM, then removes the container; its volume stays. */
  stop(): Promise<void>;
}

/**
 * Runs `file args` with `stdin` fed in (or an empty input); resolves with the exit code, stdout
 * as bytes and stderr as text. A command that cannot start rejects.
 */
export function run(
  file: string,
  args: string[],
  o: { stdin?: Buffer; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, {
      cwd: o.cwd ?? REPO_ROOT,
      env: o.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      stderr += text;
    });
    child.on('error', fail);
    child.on('close', (code, signal) =>
      done({ code: code ?? (signal ? 128 : 0), stdout: Buffer.concat(stdout), stderr }),
    );
    // A command may stop before it has read all its input (a refused restore does): that is an
    // EPIPE here, and the exit code already says what happened.
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin);
  });
}

/** `docker args`, which must succeed; its stdout as text. */
async function docker(args: string[]): Promise<string> {
  const result = await run('docker', args);
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} exited with ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout.toString('utf8');
}

/** A text with one-time setup tokens blanked, for error messages that quote server output. */
export function redact(text: string): string {
  return text.replace(/token=[^\s"&\\]+/g, 'token=[redacted]');
}

/** The last `lines` lines of `text`. */
function tail(text: string, lines = 40): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

function containerHandle(name: string, origin: string): Container {
  return {
    name,
    origin,
    async logs() {
      const result = await run('docker', ['logs', name]);
      return result.stdout.toString('utf8') + result.stderr;
    },
    exec(args, o = {}) {
      const flags = o.stdin === undefined ? [] : ['-i'];
      return run('docker', ['exec', ...flags, name, ...args], { stdin: o.stdin });
    },
    async stop() {
      await run('docker', ['stop', '--timeout', '15', name]);
      await run('docker', ['rm', '--force', name]);
    },
  };
}

/**
 * `docker run -d --name <name> -v <volume>:/data -p 127.0.0.1:<port>:8080 [-e …] <image>`, the
 * README's command with the port bound to loopback (nothing else on the network reaches the
 * run) and `--pull never` (the image is the one just built; a missing one fails at once rather
 * than being looked up on a registry). PINWALL_PUBLIC_ORIGIN is added only when the port is not
 * 8080, where the default origin already fits.
 */
export async function runImage(o: {
  image: string;
  name: string;
  volume: string;
  port: number;
  env?: Record<string, string>;
}): Promise<Container> {
  const env: Record<string, string> = { ...o.env };
  if (o.port !== 8080 && env.PINWALL_PUBLIC_ORIGIN === undefined) {
    env.PINWALL_PUBLIC_ORIGIN = `http://localhost:${o.port}`;
  }
  const origin = env.PINWALL_PUBLIC_ORIGIN ?? 'http://localhost:8080';
  await docker([
    'run',
    '--detach',
    '--pull',
    'never',
    '--name',
    o.name,
    '--volume',
    `${o.volume}:/data`,
    '--publish',
    `127.0.0.1:${o.port}:8080`,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    o.image,
  ]);
  return containerHandle(o.name, origin);
}

/** Whether the container is still running, from `docker inspect`. */
async function isRunning(name: string): Promise<boolean> {
  const result = await run('docker', ['inspect', '--format', '{{.State.Running}}', name]);
  return result.code === 0 && result.stdout.toString('utf8').trim() === 'true';
}

const POLL_MS = 250;

/** Calls `probe` until it returns a value, failing with `explain()` after `timeoutMs`. */
async function poll<T>(
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
  explain: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(await explain());
    await new Promise((wait) => setTimeout(wait, POLL_MS));
  }
}

/** Fails with the container's log tail once it has stopped running. */
async function assertRunning(c: Container): Promise<void> {
  if (!(await isRunning(c.name))) {
    throw new Error(`${c.name} stopped:\n${redact(tail(await c.logs()))}`);
  }
}

/**
 * The `setup_url` of the JSON log line the server writes once it listens without an owner.
 * Fails when the container stops, or after `timeoutMs`, with the tail of its log (tokens
 * blanked).
 */
export function waitForSetupUrl(c: Container, timeoutMs: number): Promise<string> {
  return poll(
    timeoutMs,
    async () => {
      for (const line of (await c.logs()).split('\n')) {
        if (!line.includes('"setup_url"')) continue;
        try {
          const entry = JSON.parse(line) as { setup_url?: unknown };
          if (typeof entry.setup_url === 'string') return entry.setup_url;
        } catch {
          // Not a JSON line.
        }
      }
      await assertRunning(c);
      return undefined;
    },
    async () =>
      `${c.name} logged no setup_url within ${timeoutMs / 1000} s:\n${redact(tail(await c.logs()))}`,
  );
}

/** Waits until `GET <origin>/readyz` answers 200 (an install that has an owner logs no link). */
export function waitUntilReady(c: Container, timeoutMs: number): Promise<void> {
  return poll(
    timeoutMs,
    async () => {
      const ready = await fetch(new URL('/readyz', c.origin)).then(
        (r) => r.ok,
        () => false,
      );
      if (ready) return true;
      await assertRunning(c);
      return undefined;
    },
    async () => `${c.name} was not ready within ${timeoutMs / 1000} s:\n${tail(await c.logs())}`,
  ).then(() => undefined);
}

/** Removes containers and volumes by exact name; names that do not exist are fine. */
export async function removeContainers(names: string[], volumes: string[] = []): Promise<void> {
  if (names.length > 0) await run('docker', ['rm', '--force', '--volumes', ...names]);
  if (volumes.length > 0) await run('docker', ['volume', 'rm', '--force', ...volumes]);
}

/**
 * `docker compose -p <project> -f <file> up -d --wait` with `env` for the file's variables, run
 * from the repository root. `images` replaces the image of the named services (through an
 * override file), so a suite can pin by digest what the example names by tag. The caller's
 * own PINWALL_* variables are left out: the run owns the file's configuration. `exec` runs in
 * the `pinwall` service (`exec -T`: no terminal, the bytes stay intact). A project that fails
 * to come up is taken down again before the error is thrown.
 */
export async function composeUp(o: {
  file: string;
  project: string;
  env: Record<string, string>;
  images?: Record<string, string>;
}): Promise<{
  exec: Container['exec'];
  logs(): Promise<string>;
  down(): Promise<void>;
}> {
  const files = ['-f', resolve(REPO_ROOT, o.file)];
  let overrideDir: string | null = null;
  if (o.images !== undefined) {
    overrideDir = await mkdtemp(join(tmpdir(), 'pinwall-acc-compose-'));
    const services = Object.entries(o.images)
      .map(([service, image]) => `  ${service}:\n    image: ${image}\n`)
      .join('');
    const override = join(overrideDir, 'images.yml');
    await writeFile(override, `services:\n${services}`);
    files.push('-f', override);
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PINWALL_')),
  );
  const env = { ...inherited, ...o.env };
  const compose = (args: string[], stdin?: Buffer) =>
    run('docker', ['compose', '-p', o.project, ...files, ...args], { env, stdin });

  const logs = async () => {
    const result = await compose(['logs', '--no-color', '--tail', '60']);
    return result.stdout.toString('utf8') + result.stderr;
  };
  const down = async () => {
    await compose(['down', '--volumes', '--timeout', '15']);
    if (overrideDir !== null) await rm(overrideDir, { recursive: true, force: true });
  };

  const up = await compose(['up', '--detach', '--wait']);
  if (up.code !== 0) {
    const log = await logs();
    await down();
    throw new Error(`compose up failed (${up.code}): ${up.stderr.trim()}\n${redact(log)}`);
  }
  return {
    exec: (args, x = {}) => compose(['exec', '-T', 'pinwall', ...args], x.stdin),
    logs,
    down,
  };
}
