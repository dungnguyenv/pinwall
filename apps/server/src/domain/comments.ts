import type { Comment, CommentThread } from '@pinwall/shared';
import type { Anchor } from '@pinwall/shared/protocol';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { DbDialect } from '../db/connect.ts';
import type { ArtifactRow, CommentRow, Database, UserRow, VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';
import { getArtifact } from './artifacts.ts';
import { publishLive } from './live.ts';
import { getCurrentVersion } from './versions.ts';

/** Who writes or changes a comment. */
export type CommentActor = { kind: 'member'; user: UserRow };

/** Which threads `listThreads` returns, a page at a time. */
export interface ThreadFilter {
  status: 'open' | 'resolved' | 'all';
  /** Only threads written on the version with this number. */
  versionNumber?: number;
  /** Only threads written on versions numbered up to this one. */
  maxVersionNumber?: number;
  limit: number;
  cursor: string | null;
}

/** Where the next page of threads starts: after the one written at `c` with id `i`. */
const ThreadCursor = z.object({ c: z.number().int(), i: z.string() });

/** A comment row with what its DTO needs from other tables. */
interface CommentView extends CommentRow {
  version_number: number;
  author_name: string | null;
  resolved_in_number: number | null;
  resolver_name: string | null;
}

/**
 * Comments joined to the version they were written on, their author, and for a resolved thread
 * the version it was resolved in and who resolved it: everything a thread needs in one query.
 */
function selectComments(db: Db) {
  return db
    .selectFrom('comments')
    .innerJoin('versions as written', 'written.id', 'comments.version_id')
    .leftJoin('users as author', 'author.id', 'comments.author_user_id')
    .leftJoin('versions as resolved_in', 'resolved_in.id', 'comments.resolved_in_version_id')
    .leftJoin('users as resolver', 'resolver.id', 'comments.resolved_by')
    .selectAll('comments')
    .select([
      'written.number as version_number',
      'author.name as author_name',
      'resolved_in.number as resolved_in_number',
      'resolver.name as resolver_name',
    ]);
}

/**
 * One page of the artifact's threads, in the order they were written (ties by id), each with
 * its replies. Two queries whatever the page size: one for the threads, one for their replies.
 * A missing artifact answers as `getArtifact` does (404, or 410 when deleted).
 */
export async function listThreads(
  deps: AppDeps,
  artifactId: string,
  f: ThreadFilter,
): Promise<{ items: CommentThread[]; nextCursor: string | null }> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, artifactId, deps.clock.now());
  let query = selectComments(db)
    .where('comments.artifact_id', '=', artifact.id)
    .where('comments.parent_id', 'is', null);
  if (f.status !== 'all') query = query.where('comments.status', '=', f.status);
  if (f.versionNumber !== undefined) query = query.where('written.number', '=', f.versionNumber);
  if (f.maxVersionNumber !== undefined) {
    query = query.where('written.number', '<=', f.maxVersionNumber);
  }
  if (f.cursor !== null) {
    const after = decodeCursor(f.cursor, ThreadCursor);
    query = query.where((eb) =>
      eb.or([
        eb('comments.created_at', '>', after.c),
        eb.and([eb('comments.created_at', '=', after.c), eb('comments.id', '>', after.i)]),
      ]),
    );
  }
  const rows: CommentView[] = await query
    .orderBy('comments.created_at', 'asc')
    .orderBy('comments.id', 'asc')
    .limit(f.limit + 1)
    .execute();
  const roots = rows.slice(0, f.limit);
  const last = roots.at(-1);
  const nextCursor =
    rows.length > f.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null;
  return { items: await withReplies(db, roots), nextCursor };
}

/** The thread whose first comment is `threadId`; 404 when there is none. */
export async function getThread(deps: AppDeps, threadId: string): Promise<CommentThread> {
  return readThread(deps.db.db, threadId);
}

/** The comment `id`, a thread's first comment or a reply; 404 when there is none. */
export async function getComment(db: Db, id: string): Promise<CommentRow> {
  const row = await db.selectFrom('comments').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw notFound(t('comment.notFound'));
  return row;
}

/**
 * Opens a thread on version `versionId` of the artifact, or on its current version when null.
 * The version must belong to the artifact (else 400); a missing artifact answers 404 or 410.
 * `body` and `anchor` must already be valid (`CommentBody`, `Anchor`).
 */
export async function createThread(
  deps: AppDeps,
  actor: CommentActor,
  artifactId: string,
  p: { body: string; anchor: Anchor; versionId: string | null },
): Promise<CommentThread> {
  const { db, dialect } = deps.db;
  const thread = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifact = await holdArtifact(trx, dialect, artifactId, now);
    const version =
      p.versionId === null
        ? await getCurrentVersion(trx, artifact)
        : await versionOf(trx, artifact, p.versionId);
    const id = newId('cmt');
    await trx
      .insertInto('comments')
      .values({
        ...newComment(actor, artifact.id, version.id, p.body, now),
        id,
        parent_id: null,
        anchor: JSON.stringify(p.anchor),
        status: 'open',
      })
      .execute();
    return readThread(trx, id);
  });
  publishLive(deps, { type: 'comment.created', artifact_id: thread.artifact_id, thread });
  return thread;
}

/**
 * Adds a reply to the thread of `commentId`. Threads are flat: replying to a reply adds to the
 * thread it is in. A reply belongs to the version its thread was written on, so deleting a
 * version takes whole threads, never single replies. `body` must already be valid.
 */
export async function addReply(
  deps: AppDeps,
  actor: CommentActor,
  commentId: string,
  body: string,
): Promise<{ thread: CommentThread; comment: Comment }> {
  const { db, dialect } = deps.db;
  const id = newId('cmt');
  const thread = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { comment: target } = await holdComment(trx, dialect, commentId, now);
    const root = target.parent_id === null ? target : await getComment(trx, target.parent_id);
    await trx
      .insertInto('comments')
      .values({
        ...newComment(actor, root.artifact_id, root.version_id, body, now),
        id,
        parent_id: root.id,
        anchor: null,
        status: null,
      })
      .execute();
    return readThread(trx, root.id);
  });
  publishLive(deps, { type: 'comment.created', artifact_id: thread.artifact_id, thread });
  return { thread, comment: commentIn(thread, id) };
}

/** Replaces the text of a comment; only its author may. Sets `edited_at`. */
export async function editComment(
  deps: AppDeps,
  actor: CommentActor,
  commentId: string,
  body: string,
): Promise<{ thread: CommentThread; comment: Comment }> {
  const { db, dialect } = deps.db;
  const thread = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { comment } = await holdComment(trx, dialect, commentId, now);
    if (comment.author_user_id !== actor.user.id) throw forbidden(t('comment.editForbidden'));
    await trx
      .updateTable('comments')
      .set({ body, updated_at: now, edited_at: now })
      .where('id', '=', comment.id)
      .execute();
    return readThread(trx, comment.parent_id ?? comment.id);
  });
  publishLive(deps, { type: 'comment.updated', artifact_id: thread.artifact_id, thread });
  return { thread, comment: commentIn(thread, commentId) };
}

/**
 * Deletes a comment; its author, the artifact's publisher or an admin may. Deleting a thread's
 * first comment deletes the thread with its replies.
 */
export async function deleteComment(
  deps: AppDeps,
  actor: CommentActor,
  commentId: string,
): Promise<void> {
  const { db, dialect } = deps.db;
  const outcome = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { comment, artifact } = await holdComment(trx, dialect, commentId, now);
    if (!canDeleteComment(actor, comment, artifact)) throw forbidden(t('comment.deleteForbidden'));
    const version = await trx
      .selectFrom('versions')
      .select('number')
      .where('id', '=', comment.version_id)
      .executeTakeFirstOrThrow();
    // A thread's replies go with it (the schema cascades).
    await trx.deleteFrom('comments').where('id', '=', comment.id).execute();
    const thread = comment.parent_id === null ? null : await findThread(trx, comment.parent_id);
    return { comment, versionNumber: version.number, thread };
  });
  const { comment } = outcome;
  publishLive(deps, {
    type: 'comment.deleted',
    artifact_id: comment.artifact_id,
    thread_id: comment.parent_id ?? comment.id,
    comment_id: comment.id,
    version_number: outcome.versionNumber,
    thread: outcome.thread,
  });
}

/**
 * Marks the thread of first comment `commentId` resolved by `user` in version `versionId`, or in
 * the current version when null. Any member may. The version must belong to the artifact.
 */
export async function resolveThread(
  deps: AppDeps,
  user: UserRow,
  commentId: string,
  versionId: string | null,
): Promise<CommentThread> {
  const { db, dialect } = deps.db;
  const thread = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { comment, artifact } = await holdComment(trx, dialect, commentId, now);
    assertThread(comment);
    const version =
      versionId === null
        ? await getCurrentVersion(trx, artifact)
        : await versionOf(trx, artifact, versionId);
    await trx
      .updateTable('comments')
      .set({
        status: 'resolved',
        resolved_in_version_id: version.id,
        resolved_by: user.id,
        resolved_at: now,
        updated_at: now,
      })
      .where('id', '=', comment.id)
      .execute();
    return readThread(trx, comment.id);
  });
  publishLive(deps, { type: 'comment.resolved', artifact_id: thread.artifact_id, thread });
  return thread;
}

/** Opens the thread of first comment `commentId` again. Any member may. */
export async function reopenThread(
  deps: AppDeps,
  _user: UserRow,
  commentId: string,
): Promise<CommentThread> {
  const { db, dialect } = deps.db;
  const thread = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { comment } = await holdComment(trx, dialect, commentId, now);
    assertThread(comment);
    await trx
      .updateTable('comments')
      .set({
        status: 'open',
        resolved_in_version_id: null,
        resolved_by: null,
        resolved_at: null,
        updated_at: now,
      })
      .where('id', '=', comment.id)
      .execute();
    return readThread(trx, comment.id);
  });
  publishLive(deps, { type: 'comment.reopened', artifact_id: thread.artifact_id, thread });
  return thread;
}

/** How many open threads each artifact in `artifactIds` has; those with none are left out. */
export async function countOpenThreads(
  db: Db,
  artifactIds: readonly string[],
): Promise<Map<string, number>> {
  if (artifactIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('comments')
    .select((eb) => ['artifact_id', eb.fn.countAll().as('count')])
    .where('artifact_id', 'in', artifactIds)
    .where('parent_id', 'is', null)
    .where('status', '=', 'open')
    .groupBy('artifact_id')
    .execute();
  return new Map(rows.map((row) => [row.artifact_id, Number(row.count)]));
}

/** Whether `actor` may delete `comment`: its author, the artifact's publisher, or an admin. */
function canDeleteComment(
  actor: CommentActor,
  comment: CommentRow,
  artifact: ArtifactRow,
): boolean {
  const { user } = actor;
  return (
    comment.author_user_id === user.id ||
    artifact.created_by === user.id ||
    effectiveRole(user) === 'admin'
  );
}

/** Only a thread's first comment carries its status. */
function assertThread(comment: CommentRow): void {
  if (comment.parent_id !== null) throw badRequest(t('comment.notThread'));
}

/** The columns every new comment shares, root or reply. */
function newComment(
  actor: CommentActor,
  artifactId: string,
  versionId: string,
  body: string,
  now: number,
) {
  return {
    artifact_id: artifactId,
    version_id: versionId,
    author_user_id: actor.user.id,
    guest_name: null,
    share_link_id: null,
    body,
    resolved_in_version_id: null,
    resolved_by: null,
    resolved_at: null,
    created_at: now,
    updated_at: now,
    edited_at: null,
  };
}

/**
 * The artifact `id`, held until `trx` ends: share-locked on Postgres, so a version or artifact
 * deletion (which locks it for update) and a comment write take turns instead of racing on the
 * version the comment points at. On SQLite a transaction has the database to itself. A missing
 * artifact answers as `getArtifact` does.
 */
async function holdArtifact(
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

/** The comment `id` and its artifact, held as `holdArtifact` holds it. */
async function holdComment(
  trx: Transaction<Database>,
  dialect: DbDialect,
  id: string,
  now: number,
): Promise<{ comment: CommentRow; artifact: ArtifactRow }> {
  const seen = await getComment(trx, id);
  const artifact = await holdArtifact(trx, dialect, seen.artifact_id, now);
  // A deletion the lock waited for may have taken the comment along.
  const comment = dialect === 'postgres' ? await getComment(trx, id) : seen;
  return { comment, artifact };
}

/** Version `versionId` of `artifact`; 400 when the artifact has no such version. */
async function versionOf(db: Db, artifact: ArtifactRow, versionId: string): Promise<VersionRow> {
  const version = await db
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', versionId)
    .where('artifact_id', '=', artifact.id)
    .executeTakeFirst();
  if (version === undefined) throw badRequest(t('version.notInArtifact'), { field: 'version_id' });
  return version;
}

async function readThread(db: Db, threadId: string): Promise<CommentThread> {
  const thread = await findThread(db, threadId);
  if (thread === null) throw notFound(t('comment.notFound'));
  return thread;
}

/** The thread whose first comment is `threadId`, or null when there is none. */
async function findThread(db: Db, threadId: string): Promise<CommentThread | null> {
  const root = await selectComments(db)
    .where('comments.id', '=', threadId)
    .where('comments.parent_id', 'is', null)
    .executeTakeFirst();
  if (root === undefined) return null;
  const [thread] = await withReplies(db, [root]);
  return thread ?? null;
}

/** Threads for `roots`, with the replies of all of them read in one query, oldest first. */
async function withReplies(db: Db, roots: readonly CommentView[]): Promise<CommentThread[]> {
  const replies = new Map<string, Comment[]>(roots.map((root) => [root.id, []]));
  if (roots.length > 0) {
    const rows: CommentView[] = await selectComments(db)
      .where('comments.parent_id', 'in', [...replies.keys()])
      .orderBy('comments.created_at', 'asc')
      .orderBy('comments.id', 'asc')
      .execute();
    for (const row of rows) replies.get(row.parent_id ?? '')?.push(toComment(row));
  }
  return roots.map((root) => toThread(root, replies.get(root.id) ?? []));
}

function commentIn(thread: CommentThread, id: string): Comment {
  if (thread.id === id) return toPlainComment(thread);
  const reply = thread.replies.find((c) => c.id === id);
  if (reply === undefined) throw new Error(`comment ${id} is not in thread ${thread.id}`);
  return reply;
}

/** A thread's first comment without the thread fields. */
function toPlainComment(thread: CommentThread): Comment {
  const { id, thread_id, artifact_id, version, author, body, created_at, updated_at, edited_at } =
    thread;
  return { id, thread_id, artifact_id, version, author, body, created_at, updated_at, edited_at };
}

function toComment(row: CommentView): Comment {
  return {
    id: row.id,
    thread_id: row.parent_id ?? row.id,
    artifact_id: row.artifact_id,
    version: { id: row.version_id, number: row.version_number },
    author:
      row.guest_name === null
        ? { type: 'member', user_id: row.author_user_id, name: row.author_name }
        : { type: 'guest', name: row.guest_name },
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
    edited_at: row.edited_at,
  };
}

function toThread(root: CommentView, replies: Comment[]): CommentThread {
  if (root.anchor === null) throw new Error(`thread ${root.id} has no anchor`);
  const resolved = root.status === 'resolved';
  return {
    ...toComment(root),
    // Validated as `Anchor` before it was stored.
    anchor: JSON.parse(root.anchor) as Anchor,
    status: resolved ? 'resolved' : 'open',
    resolved_in_version:
      root.resolved_in_version_id === null || root.resolved_in_number === null
        ? null
        : { id: root.resolved_in_version_id, number: root.resolved_in_number },
    // A resolver whose account is gone shows as an unknown member.
    resolved_by: resolved ? { user_id: root.resolved_by, name: root.resolver_name } : null,
    resolved_at: root.resolved_at,
    replies,
  };
}
