import { api } from './client.ts';
import {
  Comment,
  CommentThread,
  CommentThreadList,
  type CreateThreadRequest,
  MAX_ANCHORS,
} from './dto.ts';

/** Threads asked for per request: the most the server sends. */
const THREAD_PAGE_SIZE = 200;

/**
 * Reads a thread list to its end, a page at a time, through `readPage`. It stops
 * at `MAX_ANCHORS` threads, the most one page of an artifact can show pinned,
 * and when the server repeats a cursor, so a misbehaving server cannot keep the
 * loop going.
 */
export async function readAllThreads(
  readPage: (cursor: string | null) => Promise<CommentThreadList>,
): Promise<CommentThread[]> {
  const threads: CommentThread[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: CommentThreadList = await readPage(cursor);
    threads.push(...page.items);
    cursor = page.next_cursor;
    if (cursor !== null && seen.has(cursor)) break;
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null && threads.length < MAX_ANCHORS);
  return threads.slice(0, MAX_ANCHORS);
}

/** Every thread of an artifact, resolved ones too, in the order they were written. */
export function listAllThreads(artifactId: string): Promise<CommentThread[]> {
  return readAllThreads((cursor) =>
    api(`/artifacts/${encodeURIComponent(artifactId)}/comments`, {
      query: { status: 'all', limit: THREAD_PAGE_SIZE, cursor },
      schema: CommentThreadList,
    }),
  );
}

/** Opens a thread; without `version_id` the server writes it on the current version. */
export function createThread(
  artifactId: string,
  body: CreateThreadRequest,
): Promise<CommentThread> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/comments`, {
    method: 'POST',
    body,
    schema: CommentThread,
  });
}

/** Replies to a thread, named by its first comment's id. */
export function replyTo(commentId: string, body: string): Promise<Comment> {
  return api(`/comments/${encodeURIComponent(commentId)}/replies`, {
    method: 'POST',
    body: { body },
    schema: Comment,
  });
}

export function editComment(commentId: string, body: string): Promise<Comment> {
  return api(`/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: { body },
    schema: Comment,
  });
}

/** Deleting a thread's first comment deletes the whole thread. */
export function deleteComment(commentId: string): Promise<void> {
  return api(`/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
}

/** Marks the thread resolved in the version `versionId`. */
export function resolveThread(commentId: string, versionId: string): Promise<CommentThread> {
  return api(`/comments/${encodeURIComponent(commentId)}/resolve`, {
    method: 'POST',
    body: { version_id: versionId },
    schema: CommentThread,
  });
}

export function reopenThread(commentId: string): Promise<CommentThread> {
  return api(`/comments/${encodeURIComponent(commentId)}/reopen`, {
    method: 'POST',
    schema: CommentThread,
  });
}
