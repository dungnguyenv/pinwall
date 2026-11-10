import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, ConfigError } from './types.ts';

const MIN_KEY_BYTES = 32;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Decodes the instance secret from text: exactly 64 hex characters, otherwise base64 or base64url.
 * Throws an Error (without echoing the value) when the text is malformed or decodes to under 32 bytes.
 */
export function decodeSecretKey(text: string): Buffer {
  const value = text.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new Error(
      'must be 64 hex characters or base64 (generate one with: openssl rand -hex 32)',
    );
  }
  const key = Buffer.from(value, 'base64');
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(
      `must decode to at least ${MIN_KEY_BYTES} bytes, got ${key.length} (generate one with: openssl rand -hex 32)`,
    );
  }
  return key;
}

function readKeyFile(file: string): Buffer {
  const key = readFileSync(file);
  if (key.length < MIN_KEY_BYTES) {
    throw new ConfigError([
      `${file}: holds ${key.length} bytes but a secret key needs at least ${MIN_KEY_BYTES}. ` +
        'Restore it from a backup, or delete it only if nothing has been encrypted with it yet.',
    ]);
  }
  return key;
}

/**
 * Returns the instance secret: `PINWALL_SECRET_KEY` when configured, otherwise the key stored in
 * `<data dir>/secret.key`, generated on first use (32 random bytes, mode 0600).
 */
export function ensureSecretKey(config: Config, logger: { warn(msg: string): void }): Buffer {
  if (config.secretKey) return config.secretKey;

  const file = join(config.dataDir, 'secret.key');
  try {
    return readKeyFile(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  mkdirSync(config.dataDir, { recursive: true });
  const key = randomBytes(MIN_KEY_BYTES);
  try {
    writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Another process created it between the read and the write: use theirs.
    if (errorCode(error) === 'EEXIST') return readKeyFile(file);
    throw error;
  }
  logger.warn(
    `PINWALL_SECRET_KEY is not set; generated a new secret key at ${file}. ` +
      'Back it up with the database: encrypted values cannot be read without it.',
  );
  return key;
}
