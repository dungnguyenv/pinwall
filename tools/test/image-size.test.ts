import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, test, vi } from 'vitest';
import { compressedSize, MAX_COMPRESSED_BYTES, main } from '../src/image-size.ts';
import { makeRoot } from './helpers.ts';

const run = promisify(execFile);
const MIB = 1024 * 1024;

/** A `docker save` stand-in: 1 MiB of zeros, in 64 KiB chunks. */
function zeros(): Readable {
  return Readable.from(Array.from({ length: 16 }, () => Buffer.alloc(MIB / 16)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('the limit is the 200 MB of the image constraint', () => {
  expect(MAX_COMPRESSED_BYTES).toBe(200_000_000);
});

test('compressedSize is the length of the gzip, level 6, of what `save` produces', async () => {
  const seen: string[] = [];
  const size = await compressedSize('pinwall:test', (image) => {
    seen.push(image);
    return zeros();
  });
  expect(seen).toEqual(['pinwall:test']);
  expect(size).toBe(gzipSync(Buffer.alloc(MIB), { level: 6 }).length);
  expect(size).toBeGreaterThan(0);
  expect(size).toBeLessThan(MIB);
});

test('compressedSize rejects when the save stream fails instead of reporting a small size', async () => {
  const broken = () =>
    new Readable({
      read() {
        this.push(Buffer.alloc(1024));
        this.destroy(new Error('docker save failed'));
      },
    });
  await expect(compressedSize('pinwall:test', broken)).rejects.toThrow('docker save failed');
});

test('main prints the size and succeeds under the limit', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const expected = gzipSync(Buffer.alloc(MIB), { level: 6 }).length;
  expect(await main(['pinwall:test'], zeros)).toBe(0);
  expect(log).toHaveBeenCalledWith(
    `pinwall:test: ${expected} bytes compressed (≈ ${(expected / 1_000_000).toFixed(1)} MB)`,
  );
});

test('main exits 1 when the size reaches the limit, and says so on stderr', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main(['pinwall:test', '--max', '10'], zeros)).toBe(1);
  expect(log).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('10 bytes'));
});

test('main treats a size equal to the limit as over it', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const exact = gzipSync(Buffer.alloc(MIB), { level: 6 }).length;
  expect(await main(['pinwall:test', '--max', String(exact)], zeros)).toBe(1);
  expect(await main(['pinwall:test', '--max', String(exact + 1)], zeros)).toBe(0);
});

test('main exits 2 on a missing image, a bad --max or an extra argument', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main([], zeros)).toBe(2);
  expect(await main(['pinwall:test', '--max', 'lots'], zeros)).toBe(2);
  expect(await main(['pinwall:test', '--max', '0'], zeros)).toBe(2);
  expect(await main(['pinwall:test', 'other'], zeros)).toBe(2);
  expect(error).toHaveBeenCalledTimes(4);
});

test('main exits 1 and names the image when saving it fails', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const missing = () =>
    new Readable({
      read() {
        this.destroy(new Error('no such image'));
      },
    });
  expect(await main(['pinwall:missing'], missing)).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('no such image'));
});

/** Runs the real command line with a `docker` first on PATH that stands in for the daemon. */
async function cli(dockerScript: string, ...args: string[]) {
  const bin = await makeRoot();
  await writeFile(join(bin, 'docker'), `#!/bin/sh\n${dockerScript}\n`);
  await chmod(join(bin, 'docker'), 0o755);
  const tools = join(import.meta.dirname, '..');
  return run(process.execPath, ['--import', 'tsx', 'src/image-size.ts', ...args], {
    cwd: tools,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (failure: { code: number; stdout: string; stderr: string }) => failure,
  );
}

const saveZeros =
  'if [ "$1" = save ] && [ "$2" = pinwall:cli ]; then head -c 1048576 /dev/zero; else exit 64; fi';

test('the command line runs `docker save <image>` and prints the size', async () => {
  const result = await cli(saveZeros, 'pinwall:cli');
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/^pinwall:cli: \d+ bytes compressed \(≈ \d+\.\d MB\)\n$/);
});

test('the command line exits 1 with --max 10', async () => {
  const result = await cli(saveZeros, 'pinwall:cli', '--max', '10');
  expect(result.code).toBe(1);
  expect(result.stdout).toMatch(/^pinwall:cli: \d+ bytes compressed/);
});

test('the command line exits 1 when `docker save` fails, even after printing some bytes', async () => {
  const result = await cli(
    'head -c 1024 /dev/zero; echo "Error response from daemon: reference does not exist" >&2; exit 1',
    'pinwall:cli',
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('reference does not exist');
});
