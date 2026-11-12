import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import type { Config } from '../../config/load.ts';
import { migrateToLatest } from '../../db/migrate.ts';
import { type AppDeps, closeDeps, createDeps } from '../../deps.ts';
import { t } from '../../lib/i18n.ts';
import type { Logger } from '../../lib/logger.ts';
import { createBackup } from './backup.ts';
import type { Manifest } from './format.ts';
import { assertEmptyTarget, restoreBackup } from './restore.ts';

/** Where `runBackupCommand` writes the archive, and what to do once it is complete or failed. */
interface BackupOutput {
  stream: Writable;
  /** The archive is complete: make it visible under its name. */
  commit(): Promise<void>;
  /** The backup failed: leave nothing of the archive behind. */
  discard(): Promise<void>;
}

/** What a log line says a backup or restore moved: table rows, stored files, their bytes. */
function summarize(manifest: Manifest): { rows: number; blobs: number; bytes: number } {
  const rows = Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0);
  return { rows, blobs: manifest.blobs.count, bytes: manifest.blobs.bytes };
}

/**
 * `-` is standard output, unless it is a terminal. Any other path is written as `<out>.partial`
 * (never over an existing file, readable by its owner only) and renamed to `out` once the archive
 * is complete, so `out` is either absent or a whole archive.
 */
async function openOutput(out: string): Promise<BackupOutput> {
  if (out === '-') {
    // As tar does: a terminal would show binary noise, and the one `docker exec -t` passes the
    // stream through rewrites line endings, so the file it ends up in is no archive.
    if (process.stdout.isTTY) throw new Error(t('backup.outTerminal'));
    // The process owns it: there is nothing to rename or remove, and a failure ends the process.
    return { stream: process.stdout, commit: async () => {}, discard: async () => {} };
  }
  const exists = await lstat(out).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (exists) throw new Error(t('backup.outExists', { path: out }));

  const partial = `${out}.partial`;
  // `flush` makes the data durable before the file is closed, so a rename never publishes less.
  const stream = createWriteStream(partial, { flags: 'wx', mode: 0o600, flush: true });
  try {
    await once(stream, 'open');
  } catch (error) {
    stream.destroy();
    // A file that was already there is not ours to remove.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(t('backup.outExists', { path: partial }));
    }
    throw error;
  }

  // A failing stream is reported by `createBackup` (its pipe and its wait for `finish`), and a
  // failed close by `errored` below; this only keeps the event from being an uncaught error.
  stream.on('error', () => {});
  const closed = () =>
    stream.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => stream.once('close', resolve));
  return {
    stream,
    commit: async () => {
      await closed();
      if (stream.errored) throw stream.errored;
      await rename(partial, out);
    },
    discard: async () => {
      stream.destroy();
      await closed();
      await rm(partial, { force: true });
    },
  };
}

/**
 * Writes a backup archive of the installation `config` describes to the file `out`, or to
 * standard output when `out` is `-`, then logs `backup complete`. A file that exists is never
 * overwritten, and a backup that fails leaves no file behind. The caller turns a thrown error
 * into the exit code.
 */
export async function runBackupCommand(config: Config, logger: Logger, out: string): Promise<void> {
  // Before the database is touched: a name that is taken fails at once.
  const output = await openOutput(out);
  let deps: AppDeps | null = null;
  try {
    // A backup never changes the database; `createBackup` refuses one at another schema.
    deps = await createDeps(config, { logger }, { migrate: false });
    const { manifest } = await createBackup(deps, output.stream);
    await output.commit();
    logger.info(summarize(manifest), 'backup complete');
  } catch (error) {
    await output.discard().catch((err: unknown) => {
      logger.warn({ err }, 'The partial backup file could not be removed');
    });
    throw error;
  } finally {
    await closeQuietly(deps, logger);
  }
}

/**
 * Restores the archive in the file `input`, or on standard input when `input` is `-`, into the
 * empty installation `config` describes, then logs `restore complete`. The target is migrated
 * only once it was found empty. Each warning is logged
 * and, so that an operator who watches the terminal sees it, also printed as plain text on
 * standard error. The caller turns a thrown error into the exit code.
 */
export async function runRestoreCommand(
  config: Config,
  logger: Logger,
  input: string,
): Promise<void> {
  // Opened first, so a missing file fails before the database is touched (and as a plain
  // rejection: a read stream that fails with nobody listening would crash the process).
  const file = input === '-' ? null : await open(input, 'r');
  const stream: Readable = file === null ? process.stdin : file.createReadStream();
  let deps: AppDeps | null = null;
  try {
    // Checked before the target is migrated: a restore pointed at a database in use by mistake,
    // perhaps by an older Pinwall, must leave it as it is.
    deps = await createDeps(config, { logger }, { migrate: false });
    await assertEmptyTarget(deps);
    await migrateToLatest(deps.db);
    const { manifest, warnings } = await restoreBackup(deps, stream);
    for (const warning of warnings) logger.warn(warning);
    logger.info({ ...summarize(manifest), warnings }, 'restore complete');
    for (const warning of warnings) console.error(warning);
  } finally {
    // The restore leaves a file it never read open (it refuses a non-empty target first).
    if (file !== null) stream.destroy();
    await closeQuietly(deps, logger);
  }
}

/** Closing is housekeeping: its failure must neither hide the command's error nor fail a success. */
async function closeQuietly(deps: AppDeps | null, logger: Logger): Promise<void> {
  if (deps === null) return;
  await closeDeps(deps).catch((err: unknown) => {
    logger.warn({ err }, 'Closing the database failed');
  });
}
