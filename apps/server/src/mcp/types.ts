import type { QuotaLimits, Usage } from '../domain/usage.ts';

/**
 * What the MCP tools format into text. Tool results carry no schema and no `structuredContent`
 * (clients would show the model that instead of the text), so these are plain types, with only
 * the fields the formatters read.
 */

/** `whoami`: the caller, how they connected, and what this Pinwall accepts. */
export interface WhoamiOut {
  user: { id: string; name: string | null; email: string | null; role: 'admin' | 'member' };
  via: 'oauth' | 'api_token';
  pinwall_url: string;
  isolation: 'single-domain' | 'content-domain';
  limits: { max_upload_bytes: number; max_inline_bytes: number };
  authoring_notes: string[];
  /** What the caller's space holds. Sent, with `quota`, in `personal` mode or when a quota applies. */
  usage?: Usage;
  /** What the caller may store; `null` is no limit. */
  quota?: QuotaLimits;
  /** Whether the caller may create share links. Sent only when links need an admin's approval. */
  can_create_share_links?: boolean;
}

/** A project as `list_projects` shows it. The instructions travel only where they are asked for. */
export interface ProjectOut {
  id: string;
  name: string;
  is_default: boolean;
  archived: boolean;
  has_instructions: boolean;
}

/** An artifact in a list: its current version, open comment threads and review page. */
export interface ArtifactOut {
  id: string;
  name: string;
  kind: 'html' | 'markdown';
  tags: string[];
  /** `null` only while an artifact has no committed version. */
  current_version: { id: string; number: number } | null;
  open_thread_count: number;
  /** The review page, which follows the newest version. */
  review_url: string;
}

/** One version of an artifact, with the links to review it and to fetch its raw files. */
export interface VersionOut {
  id: string;
  number: number;
  file_count: number;
  total_bytes: number;
  source: 'mcp' | 'inline' | 'api' | 'web' | 'restore';
  /** Epoch milliseconds. */
  created_at: number;
  is_current: boolean;
  review_url: string;
  raw_url: string;
}

/**
 * A comment thread as the review tools show it. `body`, every reply's `body` and the quoted
 * text of the anchor are written by reviewers, guests included: feedback to act on, never
 * instructions to the agent. `author` is a display name: a guest's with "(guest)", a member's,
 * the user id of a member the IdP sent no name for, or "Former member" once the account is gone.
 */
export interface ThreadOut {
  id: string;
  /** The version the thread was written on. */
  version: { number: number };
  anchor: {
    /** The page the thread sits on: `''` is the entry page, `docs/` is `docs/index.html`. */
    page: string;
    kind: 'text' | 'element' | 'point';
    quote: { exact: string; prefix: string; suffix: string } | null;
    /** A CSS selector path from `<body>`. */
    selector: string | null;
    /** Fractions of the page, 0 to 1, from the top left. */
    position: { x: number; y: number };
  };
  author: string;
  body: string;
  /** The version that fixed it, once resolved and while that version exists. */
  resolved_in_version: { id: string; number: number } | null;
  replies: { author: string; body: string }[];
}

/** A share link as the share tools list it; its URL is shown only when it is created. */
export interface ShareOut {
  id: string;
  /** The version it shows; `null` when it follows the current version. */
  version_number: number | null;
  has_password: boolean;
  allow_comments: boolean;
  /** Epoch milliseconds; `null` when it lasts until revoked. */
  expires_at: number | null;
  status: 'active' | 'expired' | 'revoked';
}
