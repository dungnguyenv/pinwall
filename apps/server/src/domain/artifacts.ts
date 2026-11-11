import type { Transaction } from 'kysely';
import type { Db } from '../auth/passkeys.ts';
import type { DbDialect } from '../db/connect.ts';
import type { ArtifactRow, Database } from '../db/schema.ts';
import { badRequest, gone, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { isTombstoned } from './tombstones.ts';

/** An artifact carries at most this many tags. */
const MAX_TAGS = 20;
/** Longest tag, in characters (code points) after normalization. */
const MAX_TAG_LENGTH = 40;

/** Whitespace and control characters; a run of them inside a tag becomes one space. */
const BLANKS = /[\s\p{Cc}]+/gu;

/**
 * The artifact `id`. A missing one answers 410 when it was deleted (its tombstone is in force at
 * `now`), else 404. Pass the transaction when one is open.
 */
export async function getArtifact(db: Db, id: string, now: number): Promise<ArtifactRow> {
  const artifact = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (artifact !== undefined) return artifact;
  if (await isTombstoned(db, 'artifact', id, now)) throw gone(t('artifact.gone'));
  throw notFound(t('artifact.notFound'));
}

/**
 * Reads the artifact `id` and holds it until `trx` ends, so writers of one artifact take turns:
 * `FOR UPDATE` on Postgres; on SQLite a transaction already has the database to itself.
 */
export function lockArtifact(
  trx: Transaction<Database>,
  dialect: DbDialect,
  id: string,
): Promise<ArtifactRow | undefined> {
  return trx
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', id)
    .$if(dialect === 'postgres', (qb) => qb.forUpdate())
    .executeTakeFirst();
}

/**
 * Tags as stored: NFC, trimmed, inner whitespace and control characters collapsed to one space,
 * lowercased, without duplicates, sorted. Refuses an empty tag, one longer than
 * `MAX_TAG_LENGTH` characters, and more than `MAX_TAGS` distinct tags.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const distinct = new Set<string>();
  for (const raw of tags) {
    const tag = raw.replace(BLANKS, ' ').trim().toLowerCase().normalize('NFC');
    if (tag === '' || codePoints(tag) > MAX_TAG_LENGTH) throw badTags();
    distinct.add(tag);
  }
  if (distinct.size > MAX_TAGS) throw badTags();
  return sortTags(distinct);
}

/** The artifact's tags, in the order `normalizeTags` gives them. */
export async function getTags(db: Db, artifactId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('artifact_tags')
    .select('tag')
    .where('artifact_id', '=', artifactId)
    .execute();
  return sortTags(rows.map((row) => row.tag));
}

/** By UTF-16 code unit, in JavaScript: the databases' collations differ. */
function sortTags(tags: Iterable<string>): string[] {
  return [...tags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function badTags() {
  return badRequest(t('artifact.badTags'), { field: 'tags' });
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}
