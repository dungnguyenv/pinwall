import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import type { DbDialect } from '../db/connect.ts';
import { searchQuery } from '../db/dialect.ts';
import type { ArtifactRow, Database } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, gone, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { foldForSearch } from '../lib/search-fold.ts';
import { getProject } from './projects.ts';
import { isTombstoned } from './tombstones.ts';

/** An artifact carries at most this many tags. */
const MAX_TAGS = 20;
/** Longest tag, in characters (code points) after normalization. */
const MAX_TAG_LENGTH = 40;

/** A search query is at most this many characters; the route refuses a longer one. */
export const SEARCH_MAX_CHARS = 256;
/** Only the first this many words of a query are searched. */
export const SEARCH_MAX_WORDS = 32;
/** A search reaches at most this many of its best matches, however it is paged. */
const SEARCH_MAX_RESULTS = 1000;
/** Ids per `in (...)` list, well under either database's parameter limit. */
const ID_CHUNK = 500;
/** `listRecent` never returns more than this many. */
export const RECENT_MAX = 20;

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
 * The artifact `id`, held until `trx` ends: share-locked on Postgres, so a version or artifact
 * deletion (which locks it for update) and a write that points at one of its versions (a
 * comment, a share link) take turns instead of racing on that version. On SQLite a transaction
 * has the database to itself. A missing artifact answers as `getArtifact` does.
 */
export async function holdArtifact(
  trx: Transaction<Database>,
  dialect: DbDialect,
  id: string,
  now: number,
): Promise<ArtifactRow> {
  const row = await trx
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', id)
    .$if(dialect === 'postgres', (qb) => qb.forShare())
    .executeTakeFirst();
  return row ?? getArtifact(trx, id, now);
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

/** The tags of each artifact in `ids`, in the order `normalizeTags` gives them, in one query. */
export async function getTagsByArtifact(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const byArtifact = new Map<string, string[]>();
  if (ids.length === 0) return byArtifact;
  const rows = await db
    .selectFrom('artifact_tags')
    .select(['artifact_id', 'tag'])
    .where('artifact_id', 'in', ids)
    .execute();
  for (const row of rows) {
    const tags = byArtifact.get(row.artifact_id);
    if (tags === undefined) byArtifact.set(row.artifact_id, [row.tag]);
    else tags.push(row.tag);
  }
  for (const [id, tags] of byArtifact) byArtifact.set(id, sortTags(tags));
  return byArtifact;
}

/** Where the next unsearched page starts: after the artifact updated at `u` with id `i`. */
const ArtifactCursor = z.object({ u: z.number().int(), i: z.string() });
/** Where the next page of search results starts: after the first `o` of them. */
const SearchCursor = z.object({ o: z.number().int().min(0).max(SEARCH_MAX_RESULTS) });

/** Reads of artifacts skip those whose project is archived unless a project is asked for. */
function inActiveProjects(db: Db) {
  return db.selectFrom('projects').select('id').where('archived_at', 'is', null);
}

/**
 * One page of artifacts, narrowed by project, tag and a search. Without `q` they come by last
 * update, newest first, with ties broken by id so a page boundary never repeats or skips one.
 * With `q`, best match first; only the best 1,000 matches can be paged through. Without
 * `projectId`, artifacts of archived projects are left out; with one that does not exist, 404.
 * `q` is folded and cut to `SEARCH_MAX_WORDS` words; a blank `q` is no search.
 */
export async function listArtifacts(
  deps: AppDeps,
  p: { projectId?: string; tag?: string; q?: string; limit: number; cursor: string | null },
): Promise<{ items: ArtifactRow[]; nextCursor: string | null }> {
  const { db, dialect } = deps.db;
  if (p.projectId !== undefined) await getProject(db, p.projectId);
  const tag = p.tag === undefined ? undefined : (normalizeTags([p.tag])[0] ?? '');

  const filtered = () => {
    let query = db.selectFrom('artifacts').selectAll('artifacts');
    query =
      p.projectId === undefined
        ? query.where('artifacts.project_id', 'in', inActiveProjects(db))
        : query.where('artifacts.project_id', '=', p.projectId);
    if (tag !== undefined) {
      query = query.where('artifacts.id', 'in', (eb) =>
        eb.selectFrom('artifact_tags').select('artifact_id').where('tag', '=', tag),
      );
    }
    return query;
  };

  const folded = p.q === undefined ? '' : foldForSearch(p.q);
  if (folded === '') {
    let query = filtered();
    if (p.cursor !== null) {
      const after = decodeCursor(p.cursor, ArtifactCursor);
      query = query.where((eb) =>
        eb.or([
          eb('artifacts.updated_at', '<', after.u),
          eb.and([eb('artifacts.updated_at', '=', after.u), eb('artifacts.id', '<', after.i)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('artifacts.updated_at', 'desc')
      .orderBy('artifacts.id', 'desc')
      .limit(p.limit + 1)
      .execute();
    const items = rows.slice(0, p.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > p.limit && last ? encodeCursor({ u: last.updated_at, i: last.id }) : null;
    return { items, nextCursor };
  }

  const offset = p.cursor === null ? 0 : decodeCursor(p.cursor, SearchCursor).o;
  const words = folded.split(' ').slice(0, SEARCH_MAX_WORDS).join(' ');
  const hits = await searchQuery({ db, dialect }, words, SEARCH_MAX_RESULTS);
  // The index knows nothing of projects and tags, and may still list an artifact that is gone.
  const found = new Map<string, ArtifactRow>();
  for (let start = 0; start < hits.length; start += ID_CHUNK) {
    const rows = await filtered()
      .where('artifacts.id', 'in', hits.slice(start, start + ID_CHUNK))
      .execute();
    for (const row of rows) found.set(row.id, row);
  }
  const ranked = hits.flatMap((id) => found.get(id) ?? []);
  const items = ranked.slice(offset, offset + p.limit);
  const end = offset + items.length;
  return { items, nextCursor: end < ranked.length ? encodeCursor({ o: end }) : null };
}

/** Records that `userId` opened the artifact now, or moves an earlier view to now. */
export async function recordView(deps: AppDeps, userId: string, artifactId: string): Promise<void> {
  const now = deps.clock.now();
  await deps.db.db
    .insertInto('artifact_views')
    .values({ user_id: userId, artifact_id: artifactId, viewed_at: now })
    .onConflict((oc) => oc.columns(['user_id', 'artifact_id']).doUpdateSet({ viewed_at: now }))
    .execute();
}

/**
 * The artifacts `userId` opened last, the latest first: at most `limit`, never more than
 * `RECENT_MAX`. Those of archived projects are left out, as in the default list.
 */
export async function listRecent(
  deps: AppDeps,
  userId: string,
  limit: number,
): Promise<ArtifactRow[]> {
  const { db } = deps.db;
  return db
    .selectFrom('artifact_views')
    .innerJoin('artifacts', 'artifacts.id', 'artifact_views.artifact_id')
    .selectAll('artifacts')
    .where('artifact_views.user_id', '=', userId)
    .where('artifacts.project_id', 'in', inActiveProjects(db))
    .orderBy('artifact_views.viewed_at', 'desc')
    .orderBy('artifact_views.artifact_id', 'desc')
    .limit(Math.min(limit, RECENT_MAX))
    .execute();
}
