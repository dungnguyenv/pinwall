import { replaceEqualDeep } from '@tanstack/react-query';
import type { Comment, CommentThread, LiveEvent } from '../../api/dto.ts';

/*
 * The comment cache of one review: an array of threads in creation order, and
 * the pure functions that change it. Each returns the array it was given when
 * nothing changes (an echo of a change the cache already holds, an unknown
 * thread), so React Query and the components skip a render.
 */

/** Whose threads a cache holds: a member's view of an artifact, or what one share link shows. */
export type ThreadScope =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'share'; token: string };

export type ThreadFilter = 'open' | 'resolved' | 'all';

/** Creation order: oldest first, the id settling two made in the same millisecond. */
function byCreation(x: { created_at: number; id: string }, y: { created_at: number; id: string }) {
  return x.created_at - y.created_at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

/** `item` in its place in `list`: replaced when its id is there, else inserted in creation order. */
function upsertSorted<T extends { created_at: number; id: string }>(list: T[], item: T): T[] {
  const at = list.findIndex((existing) => existing.id === item.id);
  if (at !== -1) {
    const existing = list[at] as T;
    const merged = replaceEqualDeep(existing, item);
    if (merged === existing) return list;
    return list.with(at, merged);
  }
  const after = list.findIndex((existing) => byCreation(existing, item) > 0);
  return after === -1 ? [...list, item] : list.toSpliced(after, 0, item);
}

/** Replaces the thread with `t`'s id, or inserts `t` in creation order. */
export function upsertThread(list: CommentThread[], t: CommentThread): CommentThread[] {
  return upsertSorted(list, t);
}

/** The fields a thread's first comment shares with every comment. */
function commentFields(c: Comment): Comment {
  return {
    id: c.id,
    thread_id: c.thread_id,
    artifact_id: c.artifact_id,
    version: c.version,
    author: c.author,
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at,
    edited_at: c.edited_at,
  };
}

/**
 * Puts a comment in its thread. A thread's first comment (its id is the
 * thread's) replaces the thread's own text and author and keeps its replies,
 * anchor and status; a reply replaces the reply with its id or is inserted in
 * creation order. A comment of a thread the cache does not hold changes nothing.
 */
export function upsertComment(list: CommentThread[], c: Comment): CommentThread[] {
  const at = list.findIndex((thread) => thread.id === c.thread_id);
  const thread = list[at];
  if (thread === undefined) return list;
  const next: CommentThread =
    c.id === c.thread_id
      ? { ...thread, ...commentFields(c) }
      : { ...thread, replies: upsertSorted(thread.replies, c) };
  const merged = replaceEqualDeep(thread, next);
  return merged === thread ? list : list.with(at, merged);
}

/** Drops a reply from its thread, or, for the thread's first comment, the whole thread. */
export function removeComment(
  list: CommentThread[],
  threadId: string,
  commentId: string,
): CommentThread[] {
  const at = list.findIndex((thread) => thread.id === threadId);
  const thread = list[at];
  if (thread === undefined) return list;
  if (commentId === threadId) return list.toSpliced(at, 1);
  const replies = thread.replies.filter((reply) => reply.id !== commentId);
  return replies.length === thread.replies.length ? list : list.with(at, { ...thread, replies });
}

/** Applies a live update. Only comment events change threads; every other event returns `list`. */
export function applyLiveEvent(list: CommentThread[], e: LiveEvent): CommentThread[] {
  switch (e.type) {
    case 'comment.created':
    case 'comment.updated':
    case 'comment.resolved':
    case 'comment.reopened':
      return upsertThread(list, e.thread);
    case 'comment.deleted':
      // No thread: the deleted comment was the first one and took its thread along.
      return e.thread === null
        ? removeComment(list, e.thread_id, e.thread_id)
        : upsertThread(list, e.thread);
    default:
      return list;
  }
}

/** The threads written on version `shown` or an older one: what that version's page can show. */
export function threadsForVersion(list: CommentThread[], shown: number): CommentThread[] {
  const kept = list.filter((thread) => thread.version.number <= shown);
  return kept.length === list.length ? list : kept;
}

/**
 * The threads a status filter shows. `sticky` holds ids that stay listed
 * whatever their status: the thread someone just resolved does not vanish from
 * Open under their cursor.
 */
export function filterThreads(
  list: CommentThread[],
  f: ThreadFilter,
  sticky: ReadonlySet<string>,
): CommentThread[] {
  if (f === 'all') return list;
  const kept = list.filter((thread) => thread.status === f || sticky.has(thread.id));
  return kept.length === list.length ? list : kept;
}

export function countThreads(list: CommentThread[]): { open: number; resolved: number } {
  let open = 0;
  for (const thread of list) if (thread.status === 'open') open += 1;
  return { open, resolved: list.length - open };
}

/** Each thread's pin number: its place in `list`, counting from 1. */
export function pinNumbers(list: CommentThread[]): Map<string, number> {
  return new Map(list.map((thread, i) => [thread.id, i + 1]));
}
