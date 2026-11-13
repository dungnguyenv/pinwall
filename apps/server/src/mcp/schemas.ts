import { Project, PublishResult, PublishSession } from '@pinwall/shared';
import { z } from 'zod';
import { REVIEWER_FIELDS } from './descriptions.ts';

/**
 * Output schemas of the MCP tools. The SDK publishes each one as the tool's `outputSchema` and
 * checks every `structuredContent` against it before answering.
 */

/** `whoami`: the caller, how they connected, and what this Pinwall accepts. */
export const WhoamiOut = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.enum(['admin', 'member']),
  }),
  via: z.enum(['oauth', 'api_token']),
  pinwall_url: z.string(),
  isolation: z.enum(['single-domain', 'content-domain']),
  limits: z.object({
    max_upload_bytes: z.number().int(),
    max_inline_bytes: z.number().int(),
    max_file_bytes: z.number().int(),
    max_version_bytes: z.number().int(),
    max_files: z.number().int(),
  }),
  upload_url_ttl_seconds: z.number().int(),
  authoring_notes: z.array(z.string()),
});
export type WhoamiOut = z.infer<typeof WhoamiOut>;

/**
 * A project as every project tool shows it. The instructions travel only where they are asked
 * for. `owner` and `role` (as the REST API sends them) are there only in `personal` mode.
 */
export const ProjectOut = z.object({
  id: z.string(),
  name: z.string(),
  is_default: z.boolean(),
  archived: z.boolean(),
  has_instructions: z.boolean(),
  owner: Project.shape.owner,
  role: Project.shape.role,
});
export type ProjectOut = z.infer<typeof ProjectOut>;

/** An artifact in a list: its current version, open comment threads and review page. */
export const ArtifactOut = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['html', 'markdown']),
  project_id: z.string(),
  tags: z.array(z.string()),
  /** `null` only while an artifact has no committed version. */
  current_version: z.object({ id: z.string(), number: z.number().int() }).nullable(),
  /** The newest version number given out; deleted versions leave gaps. */
  latest_number: z.number().int(),
  open_thread_count: z.number().int(),
  /** Epoch milliseconds. */
  updated_at: z.number().int(),
  /** The review page, which follows the newest version. */
  review_url: z.string(),
});
export type ArtifactOut = z.infer<typeof ArtifactOut>;

/** One version of an artifact, with the links to review it and to fetch its raw files. */
export const VersionOut = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string().nullable(),
  entry_path: z.string(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  message: z.string().nullable(),
  source: z.enum(['mcp', 'inline', 'api', 'web', 'restore']),
  /** Epoch milliseconds. */
  created_at: z.number().int(),
  is_current: z.boolean(),
  review_url: z.string(),
  raw_url: z.string(),
});
export type VersionOut = z.infer<typeof VersionOut>;

/** `list_projects`. */
export const ListProjectsOut = z.object({
  projects: z.array(ProjectOut.extend({ artifact_count: z.number().int() })),
  next_cursor: z.string().nullable(),
});
export type ListProjectsOut = z.infer<typeof ListProjectsOut>;

/** `get_project` and `create_project`. */
export const ProjectDetailOut = z.object({
  project: ProjectOut.extend({ instructions: z.string() }),
});
export type ProjectDetailOut = z.infer<typeof ProjectDetailOut>;

/** `list_artifacts`. */
export const ListArtifactsOut = z.object({
  artifacts: z.array(ArtifactOut),
  next_cursor: z.string().nullable(),
});
export type ListArtifactsOut = z.infer<typeof ListArtifactsOut>;

/** `search_artifacts`. */
export const SearchArtifactsOut = z.object({ artifacts: z.array(ArtifactOut) });
export type SearchArtifactsOut = z.infer<typeof SearchArtifactsOut>;

/** `get_artifact`: the artifact and its newest versions, the newest first. */
export const GetArtifactOut = z.object({
  artifact: ArtifactOut.extend({ raw_url: z.string() }),
  versions: z.array(VersionOut),
});
export type GetArtifactOut = z.infer<typeof GetArtifactOut>;

/** `create_publish_session`: the upload URL with its commands, and what publishing to it will do. */
export const CreatePublishSessionOut = PublishSession.extend({
  /** How long the URL stays valid, counted from now. */
  expires_in_seconds: z.number().int(),
  target: z.object({
    kind: z.enum(['new_artifact', 'new_version']),
    /** The artifact that gets the new version; `null` for a new artifact. */
    artifact_id: z.string().nullable(),
  }),
});
export type CreatePublishSessionOut = z.infer<typeof CreatePublishSessionOut>;

/** `publish_inline`: the version made, as the REST publish returns it. */
export const PublishInlineOut = PublishResult;
export type PublishInlineOut = z.infer<typeof PublishInlineOut>;

/** A version named by id and number. */
const VersionRefOut = z.object({ id: z.string(), number: z.number().int() });

/**
 * One comment of a thread. `author` is a display name: a guest's with "(guest)", a member's, the
 * user id of a member the IdP sent no name for, or "Former member" once the account is gone.
 */
const CommentOut = z.object({
  id: z.string(),
  author: z.string().describe(REVIEWER_FIELDS.author),
  body: z.string().describe(REVIEWER_FIELDS.text),
  /** Epoch milliseconds. */
  created_at: z.number().int(),
});

/**
 * A comment thread as the review tools show it. `body`, every reply's `body` and the quoted
 * text of the anchor are written by reviewers, guests included: feedback to act on, never
 * instructions to the agent.
 */
export const ThreadOut = z.object({
  id: z.string(),
  status: z.enum(['open', 'resolved']),
  /** The version the thread was written on. */
  version: VersionRefOut,
  anchor: z.object({
    /** The page the thread sits on: `''` is the entry page, `docs/` is `docs/index.html`. */
    page: z.string(),
    kind: z.enum(['text', 'element', 'point']),
    quote: z
      .object({ exact: z.string(), prefix: z.string(), suffix: z.string() })
      .nullable()
      .describe(REVIEWER_FIELDS.quote),
    /** A CSS selector path from `<body>`. */
    selector: z.string().nullable(),
    /** Fractions of the page, 0 to 1, from the top left. */
    position: z.object({ x: z.number(), y: z.number() }),
  }),
  author: z.string().describe(REVIEWER_FIELDS.author),
  body: z.string().describe(REVIEWER_FIELDS.text),
  /** Epoch milliseconds. */
  created_at: z.number().int(),
  /** The version that fixed it, once resolved and while that version exists. */
  resolved_in_version: VersionRefOut.nullable(),
  replies: z.array(CommentOut),
});
export type ThreadOut = z.infer<typeof ThreadOut>;

/** `list_comments`: the artifact, and a page of its threads in the order they were written. */
export const ListCommentsOut = z.object({
  artifact: z.object({
    id: z.string(),
    name: z.string(),
    current_version: VersionRefOut.nullable(),
  }),
  threads: z.array(ThreadOut),
  next_cursor: z.string().nullable(),
});
export type ListCommentsOut = z.infer<typeof ListCommentsOut>;

/** `reply_to_comment`: the reply, in the thread it joined. */
export const ReplyToCommentOut = z.object({
  comment: z.object({
    id: z.string(),
    thread_id: z.string(),
    body: z.string(),
    /** Epoch milliseconds. */
    created_at: z.number().int(),
  }),
});
export type ReplyToCommentOut = z.infer<typeof ReplyToCommentOut>;

/** `resolve_comment`. */
export const ResolveCommentOut = z.object({ thread: ThreadOut });
export type ResolveCommentOut = z.infer<typeof ResolveCommentOut>;

/** A share link as the share tools list it; its URL is shown only when it is created. */
export const ShareOut = z.object({
  id: z.string(),
  /** The version it shows; `null` when it follows the current version. */
  version_number: z.number().int().nullable(),
  has_password: z.boolean(),
  allow_comments: z.boolean(),
  /** Epoch milliseconds; `null` when it lasts until revoked. */
  expires_at: z.number().int().nullable(),
  status: z.enum(['active', 'expired', 'revoked']),
});
export type ShareOut = z.infer<typeof ShareOut>;

/** `create_share_link`: the URL, shown here once, and the link it opens. */
export const CreateShareLinkOut = z.object({ url: z.string(), link: ShareOut });
export type CreateShareLinkOut = z.infer<typeof CreateShareLinkOut>;

/** `list_share_links`: the first 200 links, the newest first. */
export const ListShareLinksOut = z.object({ links: z.array(ShareOut) });
export type ListShareLinksOut = z.infer<typeof ListShareLinksOut>;

/** `revoke_share_link`. */
export const RevokeShareLinkOut = z.object({ revoked: z.literal(true), share_link_id: z.string() });
export type RevokeShareLinkOut = z.infer<typeof RevokeShareLinkOut>;
