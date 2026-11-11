import { GUEST_TOKEN_HEADER } from '../review/comments/guest.ts';
import { api } from './client.ts';
import { readAllThreads } from './comments.ts';
import {
  Comment,
  type CommentThread,
  CommentThreadList,
  CreatedShareLink,
  type CreateShareLinkRequest,
  GuestCreated,
  type GuestReplyRequest,
  type GuestThreadRequest,
  ShareInfo,
  ShareLinkList,
} from './dto.ts';

const SHARE_LINK_PAGE_SIZE = 50;
const THREAD_PAGE_SIZE = 200;

/**
 * Share viewers have no account. A 401 on a `/share/…` route means the link
 * needs its password (or the unlock ran out), never that a session ended, so
 * none of these calls signs the person out.
 */
const viewer = { redirectOn401: false } as const;

const sharePath = (token: string) => `/share/${encodeURIComponent(token)}`;

/** The share links of an artifact that still work or have lately, newest first. */
export function listShareLinks(artifactId: string, cursor?: string | null): Promise<ShareLinkList> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/share-links`, {
    query: { limit: SHARE_LINK_PAGE_SIZE, cursor },
    schema: ShareLinkList,
  });
}

/** Makes a link. The answer holds the token and URL, shown only this once. */
export function createShareLink(
  artifactId: string,
  body: CreateShareLinkRequest,
): Promise<CreatedShareLink> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/share-links`, {
    method: 'POST',
    body,
    schema: CreatedShareLink,
  });
}

export function revokeShareLink(linkId: string): Promise<void> {
  return api(`/share-links/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}

/** What a share viewer shows: the artifact, the version, and a grant to its content. */
export function getShareInfo(token: string): Promise<ShareInfo> {
  return api(sharePath(token), { schema: ShareInfo, ...viewer });
}

/** Sends the link's password; the server answers with the unlock cookie. */
export function unlockShare(token: string, password: string): Promise<void> {
  return api(`${sharePath(token)}/unlock`, { method: 'POST', body: { password }, ...viewer });
}

/** Every thread a share link shows, read the way members' are. */
export function listGuestThreads(token: string): Promise<CommentThread[]> {
  return readAllThreads((cursor) =>
    api(`${sharePath(token)}/comments`, {
      query: { status: 'all', limit: THREAD_PAGE_SIZE, cursor },
      schema: CommentThreadList,
      ...viewer,
    }),
  );
}

/** Opens a thread on the version the link shows. */
export function guestCreateThread(token: string, body: GuestThreadRequest): Promise<GuestCreated> {
  return api(`${sharePath(token)}/comments`, {
    method: 'POST',
    body,
    schema: GuestCreated,
    ...viewer,
  });
}

export function guestReply(
  token: string,
  commentId: string,
  body: GuestReplyRequest,
): Promise<GuestCreated> {
  return api(`${sharePath(token)}/comments/${encodeURIComponent(commentId)}/replies`, {
    method: 'POST',
    body,
    schema: GuestCreated,
    ...viewer,
  });
}

/** Edits a guest's own comment, proved by the `guestToken` it came with. */
export function guestEdit(
  token: string,
  commentId: string,
  body: string,
  guestToken: string,
): Promise<Comment> {
  return api(`${sharePath(token)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: { body },
    headers: { [GUEST_TOKEN_HEADER]: guestToken },
    schema: Comment,
    ...viewer,
  });
}

export function guestDelete(token: string, commentId: string, guestToken: string): Promise<void> {
  return api(`${sharePath(token)}/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
    headers: { [GUEST_TOKEN_HEADER]: guestToken },
    ...viewer,
  });
}
