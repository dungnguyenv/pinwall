import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { ensureSecretKey } from '../../src/config/secret-key.ts';
import { ConfigError } from '../../src/config/types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinwall-key-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('generates once and reuses', () => {
  const warn = vi.fn();
  const config = loadConfig({ PINWALL_DATA_DIR: dir });
  const first = ensureSecretKey(config, { warn });
  const file = join(dir, 'secret.key');
  expect(first).toHaveLength(32);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file)).toHaveLength(32);
  const second = ensureSecretKey(config, { warn });
  expect(second.equals(first)).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain(file);
});

test('creates the data dir when it does not exist yet', () => {
  const nested = join(dir, 'a', 'b');
  const key = ensureSecretKey(loadConfig({ PINWALL_DATA_DIR: nested }), { warn: () => {} });
  expect(readFileSync(join(nested, 'secret.key')).equals(key)).toBe(true);
});

test('uses PINWALL_SECRET_KEY when set', () => {
  const warn = vi.fn();
  const hex = 'ab'.repeat(32);
  const key = ensureSecretKey(loadConfig({ PINWALL_DATA_DIR: dir, PINWALL_SECRET_KEY: hex }), {
    warn,
  });
  expect(key.equals(Buffer.from(hex, 'hex'))).toBe(true);
  expect(key).toHaveLength(32);
  expect(() => statSync(join(dir, 'secret.key'))).toThrow();
  expect(warn).not.toHaveBeenCalled();
});

test('rejects short keys', () => {
  expect(() => loadConfig({ PINWALL_DATA_DIR: dir, PINWALL_SECRET_KEY: 'abcd' })).toThrow(
    ConfigError,
  );
});

test('refuses a truncated key file instead of silently replacing it', () => {
  writeFileSync(join(dir, 'secret.key'), Buffer.alloc(10, 1));
  const config = loadConfig({ PINWALL_DATA_DIR: dir });
  expect(() => ensureSecretKey(config, { warn: () => {} })).toThrow(ConfigError);
  expect(readFileSync(join(dir, 'secret.key'))).toHaveLength(10);
});
