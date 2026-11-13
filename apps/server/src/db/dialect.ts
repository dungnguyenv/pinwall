import { sql } from 'kysely';
import type { Scope } from '../domain/spaces.ts';
import { visibleCondition } from '../domain/visible-condition.ts';
import { cutToUtf8Bytes, foldForSearch, SEARCH_BODY_MAX_BYTES } from '../lib/search-fold.ts';
import type { DbDialect, DbHandle } from './connect.ts';

/**
 * Column type for timestamps, sizes and counters: `bigint` (int8) on Postgres, `integer` on
 * SQLite, where integers are already 64-bit.
 */
export function bigintCol(h: { dialect: DbDialect }): 'bigint' | 'integer' {
  return h.dialect === 'postgres' ? 'bigint' : 'integer';
}

/**
 * What the search functions need: a `DbHandle`, or `{ db: trx, dialect: h.dialect }` to run
 * inside a transaction the caller already holds.
 */
export type DbScope = Pick<DbHandle, 'db' | 'dialect'>;

export interface SearchDocument {
  artifactId: string;
  name: string;
  tags: string;
  body: string;
}

/**
 * The words search compares: runs of letters and digits in folded text. The query and, on
 * Postgres, the indexed text both go through it, so `dashboard.html`, `ops@example.com` and
 * `/docs/setup` are several words on both sides. Postgres' own parser would keep each whole;
 * SQLite's `unicode61` tokenizer splits the same way by itself.
 */
function searchWords(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/**
 * Indexes (or re-indexes) one artifact. Text is folded with `foldForSearch` first, and the body
 * is indexed up to `SEARCH_BODY_MAX_BYTES`, in whole words, on both dialects alike.
 */
export async function searchUpsert(h: DbScope, row: SearchDocument): Promise<void> {
  const name = foldForSearch(row.name);
  const tags = foldForSearch(row.tags);
  const body = cutToUtf8Bytes(foldForSearch(row.body), SEARCH_BODY_MAX_BYTES);

  if (h.dialect === 'sqlite') {
    // FTS5 tables have no unique keys, so replace the row by hand, atomically.
    const replace = async (db: DbScope['db']) => {
      await sql`delete from search_index where artifact_id = ${row.artifactId}`.execute(db);
      await sql`
        insert into search_index (artifact_id, name, tags, body)
        values (${row.artifactId}, ${name}, ${tags}, ${body})
      `.execute(db);
    };
    await (h.db.isTransaction ? replace(h.db) : h.db.transaction().execute(replace));
    return;
  }

  const all = searchWords(`${name} ${tags} ${body}`).join(' ');
  await sql`
    insert into search_index (artifact_id, name, tags, body, document)
    values (${row.artifactId}, ${name}, ${tags}, ${body},
      to_tsvector('simple', unaccent(${all}::text)))
    on conflict (artifact_id) do update set
      name = excluded.name, tags = excluded.tags, body = excluded.body, document = excluded.document
  `.execute(h.db);
}

/**
 * Removes an artifact from the index. On SQLite this is the only cleanup (FTS5 tables cannot
 * carry foreign keys), so callers run it whenever they delete an artifact.
 */
export async function searchDelete(h: DbScope, artifactId: string): Promise<void> {
  await sql`delete from search_index where artifact_id = ${artifactId}`.execute(h.db);
}

/**
 * Artifact ids whose name, tags or body contain every word of `q` as a word prefix, best match
 * first, among those `scope` sees. `q` is folded, then split into runs of letters and digits, so
 * nothing the user types is ever read as query syntax. A scope that sees everything runs the 1.0
 * query, which reads the index alone. Any other scope's condition sits in the query itself,
 * before `LIMIT`, so matches in other spaces never take the places of the viewer's own.
 */
export async function searchQuery(
  h: DbScope,
  q: string,
  limit: number,
  scope: Scope,
): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`search limit must be a non-negative integer, got ${limit}`);
  }
  const words = searchWords(foldForSearch(q));
  if (words.length === 0 || limit === 0) return [];
  const visible = visibleCondition(scope, 'a.project_id');

  if (h.dialect === 'sqlite') {
    // Each word becomes a quoted prefix term; terms side by side are ANDed.
    const match = words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' ');
    const query =
      visible === null
        ? sql<{ artifact_id: string }>`
            select artifact_id from search_index
            where search_index match ${match}
            order by rank, artifact_id
            limit ${limit}
          `
        : sql<{ artifact_id: string }>`
            select s.artifact_id from search_index s join artifacts a on a.id = s.artifact_id
            where s.search_index match ${match} and ${visible}
            order by s.rank, s.artifact_id
            limit ${limit}
          `;
    const { rows } = await query.execute(h.db);
    return rows.map((r) => r.artifact_id);
  }

  // The document went through unaccent, so the words must too. unaccent can turn a letter into
  // punctuation (U+02BC becomes an apostrophe), so each result is quoted as a tsquery lexeme
  // (quotes and backslashes escaped) before `to_tsquery` parses it: 'word':* & 'word':*
  const withQuery = sql`
    with q as (
      select to_tsquery('simple', string_agg(
        '''' || replace(replace(unaccent(word), '\\', '\\\\'), '''', '''''') || ''':*',
        ' & ')) as query
      from unnest(${words}::text[]) as word
    )`;
  const query =
    visible === null
      ? sql<{ artifact_id: string }>`${withQuery}
          select s.artifact_id from search_index s, q
          where s.document @@ q.query
          order by ts_rank(s.document, q.query) desc, s.artifact_id
          limit ${limit}
        `
      : sql<{ artifact_id: string }>`${withQuery}
          select s.artifact_id from search_index s join artifacts a on a.id = s.artifact_id, q
          where s.document @@ q.query and ${visible}
          order by ts_rank(s.document, q.query) desc, s.artifact_id
          limit ${limit}
        `;
  const { rows } = await query.execute(h.db);
  return rows.map((r) => r.artifact_id);
}
