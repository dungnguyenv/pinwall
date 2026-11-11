import type { ColumnType, Selectable } from 'kysely';

/**
 * Kysely types for every table of migration `0001_initial` (see the roadmap's Data model).
 * Timestamps are epoch milliseconds, booleans are 0/1, JSON columns hold text.
 * `search_index` is left out on purpose: its shape differs per dialect, so it is reached only
 * through the raw SQL in `dialect.ts`.
 * `tombstones` comes from migration `0002_publishing`.
 */
export interface Database {
  users: UsersTable;
  password_credentials: PasswordCredentialsTable;
  passkeys: PasskeysTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  oauth_clients: OAuthClientsTable;
  oauth_grants: OAuthGrantsTable;
  oauth_tokens: OAuthTokensTable;
  projects: ProjectsTable;
  artifacts: ArtifactsTable;
  artifact_tags: ArtifactTagsTable;
  artifact_views: ArtifactViewsTable;
  versions: VersionsTable;
  version_files: VersionFilesTable;
  blobs: BlobsTable;
  content_grants: ContentGrantsTable;
  share_links: ShareLinksTable;
  comments: CommentsTable;
  leases: LeasesTable;
  tombstones: TombstonesTable;
}

/** Set on insert and never updated: primary keys and creation times. */
type Fixed<T> = ColumnType<T, T, never>;

/** Integer 0 or 1; both dialects store booleans this way. */
export type DbBool = 0 | 1;

export type UserKind = 'owner' | 'oidc';
export type UserRole = 'admin' | 'member';
export type RoleOverride = UserRole | 'blocked';

export interface UsersTable {
  id: Fixed<string>;
  kind: UserKind;
  email: string | null;
  email_verified: DbBool;
  name: string | null;
  avatar_url: string | null;
  idp_role: UserRole | null;
  role_override: RoleOverride | null;
  oidc_issuer: string | null;
  /** Unique together with `oidc_issuer`. */
  oidc_subject: string | null;
  /** Encrypted with `encryptString`. */
  idp_refresh_token: string | null;
  idp_checked_at: number | null;
  disabled_at: number | null;
  disabled_reason: string | null;
  created_at: Fixed<number>;
  last_seen_at: number | null;
}

export interface PasswordCredentialsTable {
  user_id: Fixed<string>;
  hash: string;
  updated_at: number;
}

export interface PasskeysTable {
  id: Fixed<string>;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  /** JSON array of authenticator transports. */
  transports: string;
  name: string;
  created_at: Fixed<number>;
  last_used_at: number | null;
}

export interface SessionsTable {
  /** SHA-256 of the session cookie value. */
  id_hash: Fixed<string>;
  user_id: string;
  auth_method: string;
  created_at: Fixed<number>;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiTokensTable {
  id: Fixed<string>;
  user_id: string;
  name: string;
  token_hash: string;
  /** The first characters of the token, shown so people can tell tokens apart. */
  prefix: string;
  created_at: Fixed<number>;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface OAuthClientsTable {
  id: Fixed<string>;
  name: string;
  /** JSON array of redirect URIs. */
  redirect_uris: string;
  created_at: Fixed<number>;
  last_used_at: number | null;
}

export interface OAuthGrantsTable {
  id: Fixed<string>;
  client_id: string;
  user_id: string;
  resource: string;
  scope: string;
  created_at: Fixed<number>;
  last_used_at: number | null;
  revoked_at: number | null;
}

export type OAuthTokenKind = 'access' | 'refresh';

export interface OAuthTokensTable {
  token_hash: Fixed<string>;
  grant_id: string;
  kind: OAuthTokenKind;
  created_at: Fixed<number>;
  expires_at: number;
  used_at: number | null;
}

export interface ProjectsTable {
  id: Fixed<string>;
  name: string;
  /** Free text the agent reads before publishing; empty when unset. */
  instructions: string;
  is_default: DbBool;
  archived_at: number | null;
  created_by: string | null;
  created_at: Fixed<number>;
  updated_at: number;
}

export type ArtifactKind = 'html' | 'markdown';

export interface ArtifactsTable {
  id: Fixed<string>;
  project_id: string;
  name: string;
  kind: ArtifactKind;
  /** Not a foreign key (versions reference artifacts); null until the first version exists. */
  current_version_id: string | null;
  latest_number: number;
  created_by: string | null;
  created_at: Fixed<number>;
  updated_at: number;
}

export interface ArtifactTagsTable {
  artifact_id: Fixed<string>;
  tag: Fixed<string>;
}

/** Feeds "Recent". */
export interface ArtifactViewsTable {
  user_id: Fixed<string>;
  artifact_id: Fixed<string>;
  viewed_at: number;
}

export type VersionSource = 'mcp' | 'inline' | 'api' | 'web' | 'restore';

export interface VersionsTable {
  id: Fixed<string>;
  artifact_id: string;
  /** Unique within the artifact. */
  number: number;
  parent_version_id: string | null;
  entry_path: string;
  title: string | null;
  theme_color: string | null;
  thumbnail_path: string | null;
  file_count: number;
  total_bytes: number;
  message: string | null;
  source: VersionSource;
  restored_from_version_id: string | null;
  /** JSON object, e.g. `{"warnings": [...]}`. */
  meta: string;
  created_by: string | null;
  created_at: Fixed<number>;
}

export interface VersionFilesTable {
  version_id: Fixed<string>;
  path: Fixed<string>;
  sha256: string;
  size: number;
  content_type: string;
}

export interface BlobsTable {
  sha256: Fixed<string>;
  size: number;
  created_at: Fixed<number>;
}

export type ContentGrantMode = 'review' | 'raw';

export interface ContentGrantsTable {
  token: Fixed<string>;
  version_id: string;
  mode: ContentGrantMode;
  share_link_id: string | null;
  /**
   * The signed-in person the grant was made for (migration `0002_publishing`): revoking their
   * credentials deletes it, and it stops serving while they have no access. Null for a share
   * link's guest.
   */
  user_id: string | null;
  created_at: Fixed<number>;
  expires_at: number;
}

export interface ShareLinksTable {
  id: Fixed<string>;
  artifact_id: string;
  /** Null means the link follows the artifact's current version. */
  version_id: string | null;
  token_hash: string;
  password_hash: string | null;
  allow_comments: DbBool;
  expires_at: number | null;
  created_by: string | null;
  created_at: Fixed<number>;
  last_used_at: number | null;
  revoked_at: number | null;
}

export type CommentStatus = 'open' | 'resolved';

export interface CommentsTable {
  id: Fixed<string>;
  artifact_id: string;
  /** The version the comment was written on; deleting it deletes the thread. */
  version_id: string;
  /** Null for a thread root. */
  parent_id: string | null;
  author_user_id: string | null;
  guest_name: string | null;
  share_link_id: string | null;
  body: string;
  /** JSON; thread roots only. */
  anchor: string | null;
  /** Thread roots only. */
  status: CommentStatus | null;
  resolved_in_version_id: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: Fixed<number>;
  updated_at: number;
  edited_at: number | null;
}

export interface LeasesTable {
  name: Fixed<string>;
  holder: string;
  expires_at: number;
}

/** What a tombstone stands for; its key is the artifact id, the grant token or the share `token_hash`. */
export type TombstoneKind = 'artifact' | 'content_grant' | 'share_link';

/** Something deleted, kept so its link answers 410 rather than 404. */
export interface TombstonesTable {
  kind: Fixed<TombstoneKind>;
  key: Fixed<string>;
  deleted_at: number;
  /** Null keeps the tombstone for good. */
  expires_at: number | null;
}

export type UserRow = Selectable<UsersTable>;
export type PasswordCredentialRow = Selectable<PasswordCredentialsTable>;
export type PasskeyRow = Selectable<PasskeysTable>;
export type SessionRow = Selectable<SessionsTable>;
export type ApiTokenRow = Selectable<ApiTokensTable>;
export type OAuthClientRow = Selectable<OAuthClientsTable>;
export type OAuthGrantRow = Selectable<OAuthGrantsTable>;
export type OAuthTokenRow = Selectable<OAuthTokensTable>;
export type ProjectRow = Selectable<ProjectsTable>;
export type ArtifactRow = Selectable<ArtifactsTable>;
export type ArtifactTagRow = Selectable<ArtifactTagsTable>;
export type ArtifactViewRow = Selectable<ArtifactViewsTable>;
export type VersionRow = Selectable<VersionsTable>;
export type VersionFileRow = Selectable<VersionFilesTable>;
export type BlobRow = Selectable<BlobsTable>;
export type ContentGrantRow = Selectable<ContentGrantsTable>;
export type ShareLinkRow = Selectable<ShareLinksTable>;
export type CommentRow = Selectable<CommentsTable>;
export type LeaseRow = Selectable<LeasesTable>;
export type TombstoneRow = Selectable<TombstonesTable>;
