import { ApiError } from '../../api/client.ts';
import {
  createThread,
  deleteComment,
  editComment,
  listAllThreads,
  reopenThread,
  replyTo,
  resolveThread,
} from '../../api/comments.ts';
import type { Anchor, Comment, CommentThread, Me } from '../../api/dto.ts';
import {
  guestCreateThread,
  guestDelete,
  guestEdit,
  guestReply,
  listGuestThreads,
} from '../../api/shares.ts';
import { forgetGuestToken, guestMayChange, guestTokenFor, rememberGuestToken } from './guest.ts';
import type { ThreadScope } from './threads.ts';

/** What the person looking at the comments may do. */
export interface Permissions {
  canComment: boolean;
  canResolve: boolean;
  /** Whether comments need a name typed in first: share-link guests have no account. */
  needsGuestName: boolean;
  canEdit(c: Comment): boolean;
  canDelete(c: Comment): boolean;
}

/**
 * Where a review's comments come from and go to: the signed-in routes for a
 * member, the share-link routes for a guest. The comment panel and the live
 * stream work with this and never learn which one they have.
 */
export interface CommentBackend {
  scope: ThreadScope;
  /** The live-update stream for this review, for `EventSource`. */
  eventsPath: string;
  list(): Promise<CommentThread[]>;
  /** Members send the version the anchor came from; guests cannot, the link decides. */
  create(p: { body: string; anchor: Anchor; versionId: string | null }): Promise<CommentThread>;
  reply(threadId: string, body: string): Promise<Comment>;
  edit(commentId: string, body: string): Promise<Comment>;
  remove(commentId: string): Promise<void>;
  /** Null where the person cannot resolve: guests. */
  resolve: ((threadId: string, versionId: string) => Promise<CommentThread>) | null;
  reopen: ((threadId: string) => Promise<CommentThread>) | null;
}

/** A signed-in member's comments on an artifact. Build it once per artifact: its identity keys the hooks. */
export function memberBackend(artifactId: string): CommentBackend {
  return {
    scope: { kind: 'artifact', artifactId },
    eventsPath: `/api/v1/artifacts/${encodeURIComponent(artifactId)}/events`,
    list: () => listAllThreads(artifactId),
    create: ({ body, anchor, versionId }) =>
      createThread(artifactId, {
        body,
        anchor,
        ...(versionId === null ? {} : { version_id: versionId }),
      }),
    reply: replyTo,
    edit: editComment,
    remove: deleteComment,
    resolve: resolveThread,
    reopen: reopenThread,
  };
}

/** What the server must have sent and did not: the answer is not the shape its route promises. */
function invalidResponse(): ApiError {
  return new ApiError(200, 'invalid_response', '');
}

/**
 * A share-link guest's comments. `guestName` is read when a comment is sent,
 * so the latest name is used. Each token the server returns is kept in this
 * tab's sessionStorage, and the matching edit or delete sends it.
 */
export function guestBackend(token: string, guestName: () => string): CommentBackend {
  return {
    scope: { kind: 'share', token },
    eventsPath: `/api/v1/share/${encodeURIComponent(token)}/events`,
    list: () => listGuestThreads(token),
    // The server writes a guest's thread on the version the link shows, so `versionId` is ignored.
    create: async ({ body, anchor }) => {
      const created = await guestCreateThread(token, { guest_name: guestName(), body, anchor });
      rememberGuestToken(created.comment_id, created.guest_token);
      return created.thread;
    },
    reply: async (threadId, body) => {
      const created = await guestReply(token, threadId, { guest_name: guestName(), body });
      const reply = created.thread.replies.find((r) => r.id === created.comment_id);
      if (reply === undefined) throw invalidResponse();
      rememberGuestToken(created.comment_id, created.guest_token);
      return reply;
    },
    // Without a token the server answers 403 in its own words, which the person then sees.
    edit: (commentId, body) => guestEdit(token, commentId, body, guestTokenFor(commentId) ?? ''),
    remove: async (commentId) => {
      await guestDelete(token, commentId, guestTokenFor(commentId) ?? '');
      forgetGuestToken(commentId);
    },
    resolve: null,
    reopen: null,
  };
}

const isOwn = (c: Comment, me: Me) => c.author.type === 'member' && c.author.user_id === me.id;

/**
 * A member edits only their own comments. They delete their own; the
 * artifact's publisher and any admin delete anyone's.
 */
export function memberPermissions(me: Me, artifact: { created_by: string | null }): Permissions {
  const moderates = me.id === artifact.created_by || me.role === 'admin';
  return {
    canComment: true,
    canResolve: true,
    needsGuestName: false,
    canEdit: (c) => isOwn(c, me),
    canDelete: (c) => isOwn(c, me) || moderates,
  };
}

/** A guest comments, but resolves nothing, and changes only what this browser wrote in the last 15 minutes. */
export function guestPermissions(now: () => number): Permissions {
  return {
    canComment: true,
    canResolve: false,
    needsGuestName: true,
    canEdit: (c) => guestMayChange(c, now()),
    canDelete: (c) => guestMayChange(c, now()),
  };
}
