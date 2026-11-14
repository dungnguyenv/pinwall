import {
  type CommentAuthor,
  CommentBody,
  type CommentThread,
  type ShareLink,
} from '@pinwall/shared';
import { z } from 'zod';
import { enforceRateLimit, RATE_RULES } from '../../auth/rate-limits.ts';
import type { ArtifactRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { getArtifact } from '../../domain/artifacts.ts';
import { addReply, listThreads, resolveThread } from '../../domain/comments.ts';
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  shareUrl,
  toShareLinks,
} from '../../domain/shares.ts';
import { scopeForUser } from '../../domain/spaces.ts';
import { getVersionsById } from '../../domain/versions.ts';
import { gone } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { DESCRIPTIONS, FIELDS } from '../descriptions.ts';
import { formatThread, oneLine, withMore } from '../format.ts';
import { runTool } from '../results.ts';
import {
  CreateShareLinkOut,
  ListCommentsOut,
  ListShareLinksOut,
  ReplyToCommentOut,
  ResolveCommentOut,
  RevokeShareLinkOut,
  type ShareOut,
  type ThreadOut,
} from '../schemas.ts';
import type { ToolModule } from '../server.ts';

const DAY_MS = 86_400_000;
/** The most share links `list_share_links` shows. */
const SHARE_LIST_LIMIT = 200;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const artifactIdField = z.string().min(1).max(100).describe(FIELDS.artifactId);
const commentIdField = z.string().min(1).max(100).describe(FIELDS.commentId);
const versionIdField = z.string().min(1).max(100);

const ListCommentsIn = z.object({
  artifact_id: artifactIdField,
  status: z
    .enum(['open', 'resolved', 'all'])
    .default('open')
    .describe('Which threads to list: open (the default), resolved, or all.'),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Only threads written on the version with this number (1, 2, ...), not its id.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Most threads to return.'),
  cursor: z.string().min(1).max(1000).optional().describe(FIELDS.cursor),
});

const ReplyToCommentIn = z.object({
  comment_id: commentIdField.describe(
    `${FIELDS.commentId} The first comment of a thread or any reply in it.`,
  ),
  body: CommentBody.describe('What you reply, up to 10,000 characters of plain text.'),
});

const ResolveCommentIn = z.object({
  comment_id: commentIdField.describe(
    `${FIELDS.commentId} The first comment of the thread, not a reply.`,
  ),
  version_id: versionIdField
    .optional()
    .describe(
      `${FIELDS.versionId} The version that fixed the comment. Leave out for the current version.`,
    ),
});

const CreateShareLinkIn = z.object({
  artifact_id: artifactIdField,
  version_id: versionIdField
    .optional()
    .describe(`${FIELDS.versionId} Show only this version. Leave out to follow the current one.`),
  password: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('Ask viewers for this password (at least 8 characters). Leave out for no password.'),
  expires_in_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('The link stops working after this many days. Leave out to last until revoked.'),
  allow_comments: z
    .boolean()
    .default(false)
    .describe('true lets viewers leave comments; by default they only read.'),
});

const ListShareLinksIn = z.object({
  artifact_id: artifactIdField,
  include_revoked: z.boolean().default(false).describe('true also lists revoked links.'),
});

const RevokeShareLinkIn = z.object({
  share_link_id: z
    .string()
    .min(1)
    .max(100)
    .describe('The id of a share link (shr_...), from list_share_links or create_share_link.'),
});

/** The name a comment's author is shown under: a member's, a guest's with a note, or a stand-in. */
function authorName(author: CommentAuthor): string {
  if (author.type === 'guest') return t('mcp.comment.guest', { name: oneLine(author.name) });
  const name = author.name === null ? '' : oneLine(author.name);
  if (name !== '') return name;
  // No user id left means the account is gone; a member the IdP sent no name for is known by id.
  return author.user_id ?? t('mcp.comment.formerMember');
}

function toThreadOut(th: CommentThread): ThreadOut {
  const { anchor } = th;
  return {
    id: th.id,
    status: th.status,
    version: { id: th.version.id, number: th.version.number },
    anchor: {
      page: anchor.page,
      kind: anchor.kind,
      quote: anchor.quote ?? null,
      selector: anchor.dom?.path ?? null,
      position: { x: anchor.position.x, y: anchor.position.y },
    },
    author: authorName(th.author),
    body: th.body,
    created_at: th.created_at,
    resolved_in_version: th.resolved_in_version,
    replies: th.replies.map((reply) => ({
      id: reply.id,
      author: authorName(reply.author),
      body: reply.body,
      created_at: reply.created_at,
    })),
  };
}

function toShareOut(link: ShareLink): ShareOut {
  return {
    id: link.id,
    version_number: link.version === null ? null : link.version.number,
    has_password: link.has_password,
    allow_comments: link.allow_comments,
    expires_at: link.expires_at,
    status: link.status,
  };
}

/** The version the artifact's current version id names, or null while it has none. */
async function currentVersionOf(
  deps: AppDeps,
  artifact: ArtifactRow,
): Promise<{ id: string; number: number } | null> {
  const id = artifact.current_version_id;
  if (id === null) return null;
  const version = (await getVersionsById(deps.db.db, [id])).get(id);
  return version === undefined ? null : { id, number: version.number };
}

/** What a share link does, in a phrase: its version, password, comments and expiry. */
function shareDetails(link: ShareOut): string {
  return [
    link.version_number === null
      ? t('mcp.share.follows')
      : t('mcp.share.shows', { number: link.version_number }),
    link.has_password ? t('mcp.share.password') : t('mcp.share.noPassword'),
    link.allow_comments ? t('mcp.share.commentsOn') : t('mcp.share.commentsOff'),
    link.expires_at === null
      ? t('mcp.share.noExpiry')
      : t('mcp.share.expires', { at: new Date(link.expires_at).toISOString() }),
  ].join(', ');
}

/**
 * The review tools: read the comment threads of an artifact, reply to one and resolve it, and
 * make, list and revoke share links. They call the services the REST API calls, with the
 * caller's own user, so who may read, write or revoke is decided there and live listeners hear
 * every reply and resolve. Comment texts are reviewer input: they reach the model only as quoted
 * data (`formatThread`), and share-link secrets appear once, in the result that creates a link.
 */
export const reviewTools: ToolModule = (server, ctx) => {
  const { deps, auth } = ctx;
  const { user } = auth;
  /** The caller's scope, for each call to pass to the services it reads through. */
  const scope = () => scopeForUser(deps, user);

  server.registerTool(
    'list_comments',
    {
      ...DESCRIPTIONS.list_comments,
      inputSchema: ListCommentsIn,
      outputSchema: ListCommentsOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ListCommentsIn>) => {
      // Answers 404 or 410 for an artifact that is missing or deleted, or that the caller does
      // not see, before any thread is read.
      const viewer = scope();
      const artifact = await getArtifact(deps.db.db, viewer, a.artifact_id, deps.clock.now());
      const { items, nextCursor } = await listThreads(deps, viewer, artifact.id, {
        status: a.status,
        ...(a.version === undefined ? {} : { versionNumber: a.version }),
        limit: a.limit,
        cursor: a.cursor ?? null,
      });
      const threads = items.map(toThreadOut);
      const current = await currentVersionOf(deps, artifact);
      const name = oneLine(artifact.name);
      const status = t(`mcp.comments.status.${a.status}`);
      const summary =
        current === null
          ? t('mcp.comments.summaryNoVersion', {
              count: threads.length,
              status,
              name,
              artifact_id: artifact.id,
            })
          : t('mcp.comments.summary', {
              count: threads.length,
              status,
              name,
              artifact_id: artifact.id,
              number: current.number,
              version_id: current.id,
            });
      const lines = [
        summary,
        // Said once, ahead of the first comment, in the tool's own voice.
        ...(threads.length === 0 ? [] : [t('mcp.comments.untrusted')]),
        ...threads.map(formatThread),
      ];
      return {
        text: withMore(lines, 'list_comments', nextCursor),
        structured: {
          artifact: { id: artifact.id, name: artifact.name, current_version: current },
          threads,
          next_cursor: nextCursor,
        },
      };
    }),
  );

  server.registerTool(
    'reply_to_comment',
    {
      ...DESCRIPTIONS.reply_to_comment,
      inputSchema: ReplyToCommentIn,
      outputSchema: ReplyToCommentOut,
      annotations: WRITES,
    },
    runTool(ctx, async (a: z.output<typeof ReplyToCommentIn>) => {
      await enforceRateLimit(ctx.c, RATE_RULES.comment, user.id);
      const { comment } = await addReply(deps, { kind: 'member', user }, a.comment_id, a.body);
      return {
        text: t('mcp.comment.replied', { thread_id: comment.thread_id, id: comment.id }),
        structured: {
          comment: {
            id: comment.id,
            thread_id: comment.thread_id,
            body: comment.body,
            created_at: comment.created_at,
          },
        },
      };
    }),
  );

  server.registerTool(
    'resolve_comment',
    {
      ...DESCRIPTIONS.resolve_comment,
      inputSchema: ResolveCommentIn,
      outputSchema: ResolveCommentOut,
      annotations: WRITES,
    },
    runTool(ctx, async (a: z.output<typeof ResolveCommentIn>) => {
      await enforceRateLimit(ctx.c, RATE_RULES.comment, user.id);
      const thread = toThreadOut(
        await resolveThread(deps, user, a.comment_id, a.version_id ?? null),
      );
      const fixedIn = thread.resolved_in_version;
      return {
        text:
          fixedIn === null
            ? t('mcp.comment.resolvedNoVersion', { id: thread.id })
            : t('mcp.comment.resolved', {
                id: thread.id,
                number: fixedIn.number,
                version_id: fixedIn.id,
              }),
        structured: { thread },
      };
    }),
  );

  server.registerTool(
    'create_share_link',
    {
      ...DESCRIPTIONS.create_share_link,
      inputSchema: CreateShareLinkIn,
      outputSchema: CreateShareLinkOut,
      annotations: WRITES,
    },
    runTool(ctx, async (a: z.output<typeof CreateShareLinkIn>) => {
      await enforceRateLimit(ctx.c, RATE_RULES.shareLinkCreate, user.id);
      const { row, token } = await createShareLink(deps, user, a.artifact_id, {
        versionId: a.version_id ?? null,
        password: a.password ?? null,
        expiresAt:
          a.expires_in_days === undefined ? null : deps.clock.now() + a.expires_in_days * DAY_MS,
        allowComments: a.allow_comments,
      });
      const [shared] = await toShareLinks(deps, [row]);
      // Its version was deleted, taking the link along, the moment it was made.
      if (shared === undefined) throw gone(t('version.gone'));
      const link = toShareOut(shared);
      const url = shareUrl(deps.config, token);
      return {
        text: t('mcp.share.created', { id: link.id, url, details: shareDetails(link) }),
        structured: { url, link },
      };
    }),
  );

  server.registerTool(
    'list_share_links',
    {
      ...DESCRIPTIONS.list_share_links,
      inputSchema: ListShareLinksIn,
      outputSchema: ListShareLinksOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ListShareLinksIn>) => {
      const { items, nextCursor } = await listShareLinks(deps, scope(), a.artifact_id, {
        includeRevoked: a.include_revoked,
        limit: SHARE_LIST_LIMIT,
        cursor: null,
      });
      const links = items.map(toShareOut);
      const lines = [
        t('mcp.shares.summary', { artifact_id: a.artifact_id, count: links.length }),
        ...(links.length === 0 ? [] : [t('mcp.shares.noUrls')]),
        ...links.map((link) =>
          t('mcp.share.item', { id: link.id, details: shareDetails(link), status: link.status }),
        ),
        ...(nextCursor === null ? [] : [t('mcp.shares.truncated', { count: SHARE_LIST_LIMIT })]),
      ];
      return { text: lines.join('\n'), structured: { links } };
    }),
  );

  server.registerTool(
    'revoke_share_link',
    {
      ...DESCRIPTIONS.revoke_share_link,
      inputSchema: RevokeShareLinkIn,
      outputSchema: RevokeShareLinkOut,
      // Revoking a revoked link changes nothing.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    runTool(ctx, async (a: z.output<typeof RevokeShareLinkIn>) => {
      await revokeShareLink(deps, user, a.share_link_id);
      return {
        text: t('mcp.share.revoked', { id: a.share_link_id }),
        structured: { revoked: true as const, share_link_id: a.share_link_id },
      };
    }),
  );
};
