import type { Comment, CommentAuthor, CommentThread } from '@pinwall/shared';
import type { Anchor } from '@pinwall/shared/protocol';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { DbDialect } from '../db/connect.ts';
import type { ArtifactRow, CommentRow, Database, ShareLinkRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../lib/ids.ts';
import { getArtifact, holdArtifact } from './artifacts.ts';
import { publishLive } from './live.ts';
import { holdCommentLink, sharedVersion } from './share-access.ts';
import { getCurrentVersion, versionOf } from './versions.ts';

/** How long after writing it a guest may still edit or delete a comment. */
export const GUEST_EDIT_WINDOW_MS = 900_000;
/** The request header that carries a guest's edit token; never `Authorization`. */
export const GUEST_TOKEN_HEADER = 'x-pinwall-guest-token';

/**
 * Who writes or changes a comment: a member, or a guest of share link `shareLinkId`. A guest
 * writes with a `name` and changes a comment with the `guestToken` it got for it.
 */
export type CommentActor =
  | { kind: 'member'; user: UserRow }
  | { kind: 'guest'; shareLinkId: string; name: string | null; guestToken: string | null };

type GuestActor = Extract<CommentActor, { kind: 'guest' }>;

/** What a guest edit token stands for, kept under the token's hash. */
interface GuestTokenEntry {
  comment_id: string;
  share_link_id: string;
}

function guestTokenKey(token: string): string {
  return `guest-comment:${hashSecret(token)}`;
}

/**
 * A new token that lets the guest who wrote comment `commentId` through link `shareLinkId`
 * change it for `GUEST_EDIT_WINDOW_MS`. Only its hash is kept; the token is shown once.
 */
export async function issueGuestToken(
  deps: AppDeps,
  commentId: string,
  shareLinkId: string,
): Promise<string> {
  const token = newSecret();
  const entry: GuestTokenEntry = { comment_id: commentId, share_link_id: shareLinkId };
  await deps.oneTime.put(guestTokenKey(token), entry, GUEST_EDIT_WINDOW_MS);
  return token;
}

/**
 * Whether guest `actor` may edit or delete `c`: its token was issued for `c` through the link
 * the guest is using now, and `c` is younger than `GUEST_EDIT_WINDOW_MS`.
 */
export async function guestMayChange(
  deps: AppDeps,
  actor: GuestActor,
  c: CommentRow,
): Promise<boolean> {
  if (actor.guestToken === null) return false;
  if (deps.clock.now() >= c.created_at + GUEST_EDIT_WINDOW_MS) return false;
  const entry = await deps.oneTime.peek<GuestTokenEntry>(guestTokenKey(actor.guestToken));
  return entry !== null && entry.comment_id === c.id && entry.share_link_id === actor.shareLinkId;
}

/** What the viewers of a share link may see: one artifact, up to the version the link shows. */
export interface ShareScope {
  artifactId: string;
  maxVersionNumber: number;
}

/** A name that is a whole email address, as an IdP that sends no name leaves it. */
const EMAIL_NAME = /^([^\s@]+)@[^\s@]+$/;

/** A member's name as share viewers see it: an email address shows as the part before `@`. */
function sharedName(name: string | null): string | null {
  if (name === null) return null;
  return EMAIL_NAME.exec(name)?.[1] ?? name;
}

function sharedAuthor(author: CommentAuthor): CommentAuthor {
  if (author.type === 'guest') return { type: 'guest', name: author.name };
  return { type: 'member', user_id: null, name: sharedName(author.name) };
}

/** A comment as share-link viewers see it: members by name only, never an account id or email. */
export function sharedComment(comment: Comment): Comment {
  return { ...comment, author: sharedAuthor(comment.author) };
}

/**
 * A thread as the viewers of a share link that shows version `shownNumber` see it: members by
 * name only, as `sharedComment` has them, and the version it was resolved in only when that is
 * not newer than the link's, so a newer one leaves just "resolved".
 */
export function sharedThread(thread: CommentThread, shownNumber: number): CommentThread {
  const { resolved_in_version: resolvedIn, resolved_by: resolver } = thread;
  return {
    ...thread,
    author: sharedAuthor(thread.author),
    resolved_in_version:
      resolvedIn !== null && resolvedIn.number <= shownNumber ? resolvedIn : null,
    resolved_by: resolver === null ? null : { user_id: null, name: sharedName(resolver.name) },
    replies: thread.replies.map(sharedComment),
  };
}

/**
 * The comment `id` if the viewers of a share link see it: on the link's artifact and written on
 * a version numbered up to the one the link shows. Any other answers 404 like a missing one, so
 * a link never confirms a comment it does not show.
 */
export async function getSharedComment(db: Db, scope: ShareScope, id: string): Promise<CommentRow> {
  const row = await db
    .selectFrom('comments')
    .innerJoin('versions as written', 'written.id', 'comments.version_id')
    .selectAll('comments')
    .where('comments.id', '=', id)
    .where('comments.artifact_id', '=', scope.artifactId)
    .where('written.number', '<=', scope.maxVersionNumber)
    .executeTakeFirst();
  if (row === undefined) throw notFound(t('comment.notFound'));
  return row;
}

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
 * `body` and `anchor` must already be valid (`CommentBody`, `Anchor`). A guest's link is
 * checked again in the transaction (`holdCommentLink`), and a version deleted since the link
 * showed it answers as `sharedVersion` does.
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
    const link = await holdGuestLink(trx, dialect, actor, now);
    const version =
      p.versionId === null
        ? await getCurrentVersion(trx, artifact)
        : link === null
          ? await versionOf(trx, artifact, p.versionId)
          : await sharedVersion(trx, artifact, link, p.versionId);
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
 * version takes whole threads, never single replies. `body` must already be valid. A guest's
 * link is checked again in the transaction (`holdCommentLink`).
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
    await holdGuestLink(trx, dialect, actor, now);
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

/**
 * Replaces the text of a comment; only its author may: the member who wrote it, or the guest
 * with its token within `GUEST_EDIT_WINDOW_MS`, through a link still open to comments (checked
 * again in the transaction). Sets `edited_at`.
 */
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
    await holdGuestLink(trx, dialect, actor, now);
    if (actor.kind === 'guest') {
      if (!(await guestMayChange(deps, actor, comment))) throw forbidden(t('comment.guestWindow'));
    } else if (comment.author_user_id !== actor.user.id) {
      throw forbidden(t('comment.editForbidden'));
    }
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
 * Deletes a comment; its author, the artifact's publisher or an admin may, and a guest with its
 * token within `GUEST_EDIT_WINDOW_MS` (the token then ends), through a link still open to
 * comments (checked again in the transaction). Deleting a thread's first comment deletes the
 * thread with its replies.
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
    await holdGuestLink(trx, dialect, actor, now);
    if (actor.kind === 'guest') {
      if (!(await guestMayChange(deps, actor, comment))) throw forbidden(t('comment.guestWindow'));
    } else if (!canDeleteComment(actor.user, comment, artifact)) {
      throw forbidden(t('comment.deleteForbidden'));
    }
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
  if (actor.kind === 'guest' && actor.guestToken !== null) {
    await deps.oneTime.delete(guestTokenKey(actor.guestToken));
  }
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

/** Whether member `user` may delete `comment`: its author, the artifact's publisher, or an admin. */
function canDeleteComment(user: UserRow, comment: CommentRow, artifact: ArtifactRow): boolean {
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

/** Who a new comment is by: a member's id, or a guest's name and the link they wrote through. */
function authorColumns(actor: CommentActor) {
  if (actor.kind === 'member') {
    return { author_user_id: actor.user.id, guest_name: null, share_link_id: null };
  }
  if (actor.name === null) throw new Error('A guest writes a comment under a name');
  return { author_user_id: null, guest_name: actor.name, share_link_id: actor.shareLinkId };
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
    ...authorColumns(actor),
    body,
    resolved_in_version_id: null,
    resolved_by: null,
    resolved_at: null,
    created_at: now,
    updated_at: now,
    edited_at: null,
  };
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

/**
 * For a guest, the link they write through, checked again once the artifact is held (see
 * `holdCommentLink`); null for a member.
 */
async function holdGuestLink(
  trx: Transaction<Database>,
  dialect: DbDialect,
  actor: CommentActor,
  now: number,
): Promise<ShareLinkRow | null> {
  return actor.kind === 'guest' ? holdCommentLink(trx, dialect, actor.shareLinkId, now) : null;
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
