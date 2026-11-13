import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  Comment,
  CommentBodyRequest,
  CommentThreadList,
  ErrorBody,
  GuestCreated,
  GuestReplyRequest,
  GuestThreadRequest,
  ShareInfo,
  ThreadQuery,
  UnlockRequest,
} from '@pinwall/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { enforceRateLimit, rateLimit } from '../auth/rate-limits.ts';
import type { AppDeps } from '../deps.ts';
import {
  addReply,
  type CommentActor,
  createThread,
  deleteComment,
  editComment,
  GUEST_TOKEN_HEADER,
  getSharedComment,
  issueGuestToken,
  listThreads,
  type ShareScope,
  sharedComment,
  sharedThread,
} from '../domain/comments.ts';
import { SHARE_LINK_TOPIC } from '../domain/live.ts';
import { ARTIFACT_TOPIC } from '../domain/search.ts';
import {
  readUnlockCookie,
  resolveCommentShare,
  resolveOpenShare,
  resolveShare,
  SHARE_RATES,
  type ShareState,
  shareInfo,
  unlockShare,
} from '../domain/share-access.ts';
import { SYSTEM_SCOPE } from '../domain/spaces.ts';
import { clientIp } from '../http/client-ip.ts';
import { LIVE_STREAM_LIMITS, type LiveStreamOptions, liveStream } from '../http/sse.ts';
import { hashSecret } from '../lib/ids.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { EVENT_STREAM_CONTENT } from './events.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/** The share token from the link: not validated here, an unknown one is a 404. */
const TokenParam = z.object({ token: z.string() });
const CommentParam = TokenParam.extend({ id: z.string() });
/** Share viewers list threads by status, a page at a time; the link decides the versions. */
const GuestThreadQuery = ThreadQuery.omit({ version: true });
const GuestTokenHeader = z.object({
  [GUEST_TOKEN_HEADER]: z
    .string()
    .optional()
    .describe('The `guest_token` the guest got when writing the comment'),
});

const linkErrors = {
  404: error('No share link has this token (`not_found`)'),
  410: error(
    'The link was revoked, expired, or deleted with what it shared (`gone`, `details.reason` `revoked`, `expired` or `deleted`)',
  ),
};
const lockedError = {
  401: error(
    'The link has a password and this browser has not unlocked it (`unauthorized`, `details.password_required`)',
  ),
};
const commentLinkErrors = {
  ...lockedError,
  404: error('No share link has this token, or the link does not show this comment (`not_found`)'),
  410: linkErrors[410],
};
const guestNote =
  'Needs no account: the share token and, for a link with a password, the unlock cookie authorize it. The link must allow comments. Members appear by name only (`user_id` is always null), and a thread resolved in a version newer than the one the link shows has no `resolved_in_version`.';

/**
 * Share info makes a content grant each time, so opening it counts per link and address: under
 * the token's hash, so the limiter never holds a token.
 */
function shareInfoRateKey(c: Context<AppEnv>): string {
  const token = c.req.param('token') ?? '';
  return `${hashSecret(token)}:${clientIp(c, c.var.deps.config.trustProxy)}`;
}

const infoRoute = createRoute({
  method: 'get',
  path: '/share/{token}',
  tags: ['share viewer'],
  summary: 'Open a share link',
  description:
    'What the share viewer shows: the artifact name, the version and a new content URL to it, `review` when the link allows comments and `raw` otherwise, and `original_url` (`/s/{token}/original`), which redirects to a new raw grant: the stored bytes, unchanged, for "Open original". Needs no account; a link with a password needs the unlock cookie set by `POST /share/{token}/unlock`. Opens are limited per link from each address.',
  middleware: [rateLimit(SHARE_RATES.info, shareInfoRateKey)] as MiddlewareHandler<AppEnv>[],
  request: { params: TokenParam },
  responses: {
    200: {
      description: 'The shared version and a content URL to it',
      content: { 'application/json': { schema: ShareInfo } },
    },
    ...lockedError,
    ...linkErrors,
    429: error('Too many opens of this link from this address (`rate_limited`)'),
  },
});

const unlockRoute = createRoute({
  method: 'post',
  path: '/share/{token}/unlock',
  tags: ['share viewer'],
  summary: 'Unlock a share link with its password',
  description:
    'Sets the unlock cookie for this link, for 24 hours or until the link expires, whichever comes first; then reload `/s/{token}`. A link without a password needs nothing and sets nothing. Attempts are limited per link, from each address and in total.',
  middleware: [jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  request: {
    params: TokenParam,
    body: { required: true, content: { 'application/json': { schema: UnlockRequest } } },
  },
  responses: {
    204: { description: 'Unlocked' },
    400: error('An invalid body'),
    401: error('Wrong password (`invalid_credentials`)'),
    403: error('A cross-site request (`forbidden`)'),
    ...linkErrors,
    429: error('Too many attempts on this link (`rate_limited`)'),
  },
});

const listCommentsRoute = createRoute({
  method: 'get',
  path: '/share/{token}/comments',
  tags: ['share viewer'],
  summary: 'List the comment threads a share link shows',
  description: `Threads written on the version the link shows or an older one, in the order they were written, each with its replies. ${guestNote}`,
  request: { params: TokenParam, query: GuestThreadQuery },
  responses: {
    200: {
      description: 'A page of threads',
      content: { 'application/json': { schema: CommentThreadList } },
    },
    400: error('A bad `status`, `limit` or `cursor`'),
    ...lockedError,
    403: error('The link does not allow comments (`forbidden`)'),
    ...linkErrors,
  },
});

const guestWriteErrors = {
  400: error('An invalid body: a guest name and a text are required'),
  ...commentLinkErrors,
  403: error('The link does not allow comments, or a cross-site request (`forbidden`)'),
  429: error('Too many comments on this link, from this address or in total (`rate_limited`)'),
};

const guestThreadRoute = createRoute({
  method: 'post',
  path: '/share/{token}/comments',
  tags: ['share viewer'],
  summary: 'Open a comment thread as a guest',
  description: `Writes the first comment of a thread on the version the link shows, signed with the guest's name. The answer holds a token that lets this guest edit or delete the comment for 15 minutes, sent back in the \`${GUEST_TOKEN_HEADER}\` header; it is shown only here. ${guestNote}`,
  middleware: [jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  request: {
    params: TokenParam,
    body: { required: true, content: { 'application/json': { schema: GuestThreadRequest } } },
  },
  responses: {
    201: {
      description: 'The new thread and the guest token for its comment',
      content: { 'application/json': { schema: GuestCreated } },
    },
    ...guestWriteErrors,
    409: error(
      'The version the link showed was deleted while the comment was sent; reload to see the current one (`conflict`)',
    ),
  },
});

const guestReplyRoute = createRoute({
  method: 'post',
  path: '/share/{token}/comments/{id}/replies',
  tags: ['share viewer'],
  summary: 'Reply in a thread as a guest',
  description: `Threads are flat: a reply to a reply joins the same thread. The answer holds a token for the reply, as for a new thread. ${guestNote}`,
  middleware: [jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  request: {
    params: CommentParam,
    body: { required: true, content: { 'application/json': { schema: GuestReplyRequest } } },
  },
  responses: {
    201: {
      description: 'The thread with the reply, and the guest token for the reply',
      content: { 'application/json': { schema: GuestCreated } },
    },
    ...guestWriteErrors,
  },
});

const guestChangeErrors = {
  ...commentLinkErrors,
  403: error(
    'The link does not allow comments; no token for this comment, or more than 15 minutes since it was written; or a cross-site request (`forbidden`)',
  ),
  429: error('Too many edits on this link from this address (`rate_limited`)'),
};

const guestEditRoute = createRoute({
  method: 'patch',
  path: '/share/{token}/comments/{id}',
  tags: ['share viewer'],
  summary: 'Edit a guest comment',
  description: `Replaces the text and sets \`edited_at\`. Only within 15 minutes of writing the comment, with the token it came with. ${guestNote}`,
  middleware: [jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  request: {
    params: CommentParam,
    headers: GuestTokenHeader,
    body: { required: true, content: { 'application/json': { schema: CommentBodyRequest } } },
  },
  responses: {
    200: { description: 'The comment', content: { 'application/json': { schema: Comment } } },
    400: error('An invalid body'),
    ...guestChangeErrors,
  },
});

const guestDeleteRoute = createRoute({
  method: 'delete',
  path: '/share/{token}/comments/{id}',
  tags: ['share viewer'],
  summary: 'Delete a guest comment',
  description: `Deleting the first comment of a thread deletes the whole thread. Only within 15 minutes of writing the comment, with the token it came with. ${guestNote}`,
  request: { params: CommentParam, headers: GuestTokenHeader },
  responses: {
    204: { description: 'Deleted' },
    ...guestChangeErrors,
  },
});

const eventsRoute = createRoute({
  method: 'get',
  path: '/share/{token}/events',
  tags: ['share viewer'],
  summary: 'Follow the changes a share link shows',
  description:
    'The live updates members get, for `EventSource`, kept to what the link shows. A link that follows the current version hears of new and deleted versions; a per-version link only of the deletion of its own version. Comment changes come only when the link allows comments, only for threads written on the version the link shows or an older one, and redacted as the comment routes are. The stream ends at once when the link is revoked or expires, after `artifact.deleted`, and for a per-version link after the `version.deleted` of its version; the link and the unlock cookie are also checked again at every heartbeat, so it ends within 25 seconds of the unlock running out. Needs no account. Opens are limited per address; a link may have 50 streams open at once, and a client address 20.',
  middleware: [rateLimit(SHARE_RATES.events)] as MiddlewareHandler<AppEnv>[],
  request: { params: TokenParam },
  responses: {
    200: { description: 'The event stream', content: EVENT_STREAM_CONTENT },
    ...lockedError,
    ...linkErrors,
    429: error(
      'Too many opens from this address (`rate_limited`, `details.retry_after_seconds`), or this link or this address already holds as many live streams as it may (`rate_limited`)',
    ),
  },
});

const noStore = { 'Cache-Control': 'no-store' };

/** The link `token` names, open to this browser's comments. */
function commentShare(c: Context<AppEnv>, token: string): Promise<ShareState> {
  return resolveCommentShare(c.var.deps, token, readUnlockCookie(c));
}

/** Link `s`'s `ShareScope` (not a spaces `Scope`): its artifact, up to the version it shows. */
function shareScopeOf(s: ShareState): ShareScope {
  return { artifactId: s.artifact.id, maxVersionNumber: s.version.number };
}

/** A new guest comment counts per address on the link, then on the link from everywhere. */
async function limitNewComment(c: Context<AppEnv>, s: ShareState): Promise<void> {
  const ip = clientIp(c, c.var.deps.config.trustProxy);
  await enforceRateLimit(c, SHARE_RATES.guestComment, `${s.link.id}:${ip}`);
  await enforceRateLimit(c, SHARE_RATES.guestCommentLink, s.link.id);
}

/** A guest edit or delete counts per address on the link. */
async function limitChange(c: Context<AppEnv>, s: ShareState): Promise<void> {
  const ip = clientIp(c, c.var.deps.config.trustProxy);
  await enforceRateLimit(c, SHARE_RATES.guestEdit, `${s.link.id}:${ip}`);
}

function guestWriter(s: ShareState, name: string): CommentActor {
  return { kind: 'guest', shareLinkId: s.link.id, name, guestToken: null };
}

function guestChanger(s: ShareState, guestToken: string | undefined): CommentActor {
  return { kind: 'guest', shareLinkId: s.link.id, name: null, guestToken: guestToken ?? null };
}

/**
 * The live stream of share link `s`, opened with `token` and `unlockCookie`. `shown`, the number
 * of the version the link shows, moves with each new version for a link that follows the
 * current one; threads written on newer versions stay out, and what goes out is redacted as
 * `sharedThread` has it. The stream ends at once when the link is revoked (`SHARE_LINK_TOPIC`),
 * expires, or loses its version; the link and the unlock are checked again at every heartbeat.
 */
function shareStream(
  deps: AppDeps,
  s: ShareState,
  token: string,
  unlockCookie: string | undefined,
): LiveStreamOptions {
  const followsCurrent = s.link.version_id === null;
  const comments = s.link.allow_comments === 1;
  let shown = s.version.number;
  return {
    topic: ARTIFACT_TOPIC(s.artifact.id),
    // A revoke ends the stream at once, and so does the link's expiry.
    endTopic: SHARE_LINK_TOPIC(s.link.id),
    endsAt: s.link.expires_at,
    quotas: [{ key: `share-link:${s.link.id}`, limit: LIVE_STREAM_LIMITS.perShareLink }],
    forward(e) {
      switch (e.type) {
        case 'version.published':
          if (!followsCurrent) return 'skip';
          shown = Math.max(shown, e.number);
          return 'send';
        case 'version.deleted':
          if (followsCurrent) return 'send';
          // A per-version link goes with its version.
          return e.number === shown ? 'send-and-close' : 'skip';
        case 'artifact.deleted':
          return 'send-and-close';
        case 'comment.deleted':
          return comments && e.version_number <= shown ? 'send' : 'skip';
        default:
          return comments && e.thread.version.number <= shown ? 'send' : 'skip';
      }
    },
    redact(e) {
      if (e.type === 'comment.deleted') {
        return { ...e, thread: e.thread === null ? null : sharedThread(e.thread, shown) };
      }
      if ('thread' in e) return { ...e, thread: sharedThread(e.thread, shown) };
      return e;
    },
    async stillAllowed() {
      const current = await resolveOpenShare(deps, token, unlockCookie);
      // A version published between opening the link and subscribing is caught up with here.
      if (followsCurrent) shown = Math.max(shown, current.version.number);
      return true;
    },
  };
}

/** The share viewer's API: authorized by the share token and the unlock cookie, never by an account. */
export function registerSharePublicRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(infoRoute, async (c) => {
    const { deps } = c.var;
    const { token } = c.req.valid('param');
    const s = await resolveShare(deps, token, readUnlockCookie(c));
    return c.json(await shareInfo(deps, s, token), 200, noStore);
  });

  api.openapi(eventsRoute, async (c) => {
    const { deps } = c.var;
    const { token } = c.req.valid('param');
    const unlockCookie = readUnlockCookie(c);
    const s = await resolveOpenShare(deps, token, unlockCookie);
    return liveStream(c, shareStream(deps, s, token, unlockCookie));
  });

  api.openapi(unlockRoute, async (c) => {
    await unlockShare(c, c.req.valid('param').token, c.req.valid('json').password);
    return c.body(null, 204, noStore);
  });

  api.openapi(listCommentsRoute, async (c) => {
    const s = await commentShare(c, c.req.valid('param').token);
    const { status, limit, cursor } = c.req.valid('query');
    // The resolved link is what lets its viewers in: it reaches only its own artifact.
    const { items, nextCursor } = await listThreads(c.var.deps, SYSTEM_SCOPE, s.artifact.id, {
      status,
      maxVersionNumber: s.version.number,
      limit,
      cursor: cursor ?? null,
    });
    const shown = s.version.number;
    const shared = items.map((thread) => sharedThread(thread, shown));
    return c.json({ items: shared, next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(guestThreadRoute, async (c) => {
    const { deps } = c.var;
    const s = await commentShare(c, c.req.valid('param').token);
    await limitNewComment(c, s);
    const { guest_name, body, anchor } = c.req.valid('json');
    const thread = await createThread(deps, guestWriter(s, guest_name), s.artifact.id, {
      body,
      anchor,
      versionId: s.version.id,
    });
    const guestToken = await issueGuestToken(deps, thread.id, s.link.id);
    return c.json(
      {
        thread: sharedThread(thread, s.version.number),
        comment_id: thread.id,
        guest_token: guestToken,
      },
      201,
      noStore,
    );
  });

  api.openapi(guestReplyRoute, async (c) => {
    const { deps } = c.var;
    const { token, id } = c.req.valid('param');
    const s = await commentShare(c, token);
    await limitNewComment(c, s);
    await getSharedComment(deps.db.db, shareScopeOf(s), id);
    const { guest_name, body } = c.req.valid('json');
    const { thread, comment } = await addReply(deps, guestWriter(s, guest_name), id, body);
    const guestToken = await issueGuestToken(deps, comment.id, s.link.id);
    return c.json(
      {
        thread: sharedThread(thread, s.version.number),
        comment_id: comment.id,
        guest_token: guestToken,
      },
      201,
      noStore,
    );
  });

  api.openapi(guestEditRoute, async (c) => {
    const { deps } = c.var;
    const { token, id } = c.req.valid('param');
    const s = await commentShare(c, token);
    await limitChange(c, s);
    await getSharedComment(deps.db.db, shareScopeOf(s), id);
    const guestToken = c.req.valid('header')[GUEST_TOKEN_HEADER];
    const { body } = c.req.valid('json');
    const { comment } = await editComment(deps, guestChanger(s, guestToken), id, body);
    return c.json(sharedComment(comment), 200, noStore);
  });

  api.openapi(guestDeleteRoute, async (c) => {
    const { deps } = c.var;
    const { token, id } = c.req.valid('param');
    const s = await commentShare(c, token);
    await limitChange(c, s);
    await getSharedComment(deps.db.db, shareScopeOf(s), id);
    const guestToken = c.req.valid('header')[GUEST_TOKEN_HEADER];
    await deleteComment(deps, guestChanger(s, guestToken), id);
    return c.body(null, 204, noStore);
  });
}
