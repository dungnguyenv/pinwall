import { createHash } from 'node:crypto';
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from 'kysely/migration';
import { z } from 'zod';
import { deriveKey } from '../../lib/crypto.ts';

/**
 * The backup archive: a plain tar holding `manifest.json`, then `tables/<table>.jsonl` for each
 * of `BACKUP_TABLES` in that order, then `blobs/<sha256>` for every stored file a version
 * references, sorted by key. Each JSONL line is one row as logical values (numbers, 0/1
 * booleans, JSON columns as text), so an archive moves between SQLite and Postgres unchanged.
 */
export const BACKUP_FORMAT = 'pinwall-backup';
/** Bumped whenever an older Pinwall could not restore what this one writes. */
export const BACKUP_FORMAT_VERSION = 1;

/** Every table a backup carries, parents before children: restore inserts in this order. */
export const BACKUP_TABLES = [
  'users',
  'password_credentials',
  'passkeys',
  'sessions',
  'api_tokens',
  'oauth_clients',
  'oauth_grants',
  'oauth_tokens',
  'projects',
  'artifacts',
  'artifact_tags',
  'artifact_views',
  'versions',
  'version_files',
  'blobs',
  'share_links',
  'content_grants',
  'comments',
  'tombstones',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/** Each table's primary key: rows are read in pages by it, so archives list rows in key order. */
export const TABLE_KEYS: Record<BackupTable, readonly string[]> = {
  users: ['id'],
  password_credentials: ['user_id'],
  passkeys: ['id'],
  sessions: ['id_hash'],
  api_tokens: ['id'],
  oauth_clients: ['id'],
  oauth_grants: ['id'],
  oauth_tokens: ['token_hash'],
  projects: ['id'],
  artifacts: ['id'],
  artifact_tags: ['artifact_id', 'tag'],
  artifact_views: ['user_id', 'artifact_id'],
  versions: ['id'],
  version_files: ['version_id', 'path'],
  blobs: ['sha256'],
  share_links: ['id'],
  content_grants: ['token'],
  comments: ['id'],
  tombstones: ['kind', 'key'],
};

/**
 * Tables a backup leaves out on purpose: leases belong to the processes running now, the search
 * index (with SQLite's FTS5 shadow tables) is rebuilt from the restored rows, and Kysely's
 * migration bookkeeping is the target's own (the manifest lists the applied migrations).
 */
export function isSkippedTable(name: string): boolean {
  return (
    name === 'leases' ||
    name === 'search_index' ||
    name.startsWith('search_index_') ||
    name === DEFAULT_MIGRATION_TABLE ||
    name === DEFAULT_MIGRATION_LOCK_TABLE
  );
}

export interface TableStats {
  rows: number;
  bytes: number;
  /** Hex SHA-256 of the table's JSONL entry. */
  sha256: string;
}

/** `manifest.json`, the archive's first entry. */
export interface Manifest {
  format: 'pinwall-backup';
  format_version: number;
  pinwall_version: string;
  /** When the snapshot was taken, epoch milliseconds. */
  created_at: number;
  source: { database: 'sqlite' | 'postgres'; storage: 'local' | 's3' };
  /** The migrations applied to the source database, in order. */
  migrations: string[];
  /** `keyFingerprint` of the source's secret key: 64 hex. */
  key_fingerprint: string;
  tables: Record<BackupTable, TableStats>;
  blobs: { count: number; bytes: number };
}

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Count = z.number().int().nonnegative();
const TableStatsSchema = z.object({ rows: Count, bytes: Count, sha256: Sha256Hex });

export const ManifestSchema: z.ZodType<Manifest> = z.object({
  format: z.literal(BACKUP_FORMAT),
  format_version: z.number().int().positive(),
  pinwall_version: z.string().min(1),
  created_at: Count,
  source: z.object({
    database: z.enum(['sqlite', 'postgres']),
    storage: z.enum(['local', 's3']),
  }),
  migrations: z.array(z.string().min(1)),
  key_fingerprint: Sha256Hex,
  tables: z.object(
    Object.fromEntries(BACKUP_TABLES.map((table) => [table, TableStatsSchema])) as Record<
      BackupTable,
      typeof TableStatsSchema
    >,
  ),
  blobs: z.object({ count: Count, bytes: Count }),
});

/**
 * Tells whether two installations share a secret key without revealing it: the hex SHA-256 of
 * a key derived for this purpose alone.
 */
export function keyFingerprint(secretKey: Buffer): string {
  return createHash('sha256').update(deriveKey(secretKey, 'backup-key-fingerprint')).digest('hex');
}
