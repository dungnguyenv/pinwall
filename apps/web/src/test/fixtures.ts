import { z } from 'zod';
import {
  ArtifactSummary,
  Comment,
  CommentThread,
  ContentGrant,
  Me,
  Project,
  PublicConfig,
  page,
  ShareInfo,
  ShareLink,
  VersionSummary,
} from '../api/dto.ts';

const CREATED = Date.UTC(2026, 10, 1);

/**
 * Sample API data. Each fixture is parsed with its shared schema, so a
 * fixture that drifts from the DTO fails loudly instead of testing a shape
 * the server never sends.
 */
export const fx = {
  me(o: Partial<Me> = {}): Me {
    return Me.parse({
      id: 'usr_0000000000000000000a',
      kind: 'owner',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      email_verified: true,
      avatar_url: null,
      role: 'admin',
      via: 'session',
      credentials: { password: true, passkeys: 1 },
      created_at: CREATED,
      ...o,
    });
  },

  config(o: Partial<PublicConfig> = {}): PublicConfig {
    return PublicConfig.parse({
      setup_required: false,
      oidc: { enabled: false, display_name: null },
      isolation: 'single-domain',
      passkeys_available: true,
      limits: {
        max_upload_bytes: 95_000_000,
        max_inline_bytes: 2_000_000,
        max_file_bytes: 50_000_000,
        max_version_bytes: 500_000_000,
        max_files: 10_000,
        max_expansion_ratio: 100,
      },
      ...o,
    });
  },

  /** An active project that is not the default one. */
  project(o: Partial<Project> = {}): Project {
    return Project.parse({
      id: 'prj_1',
      name: 'Launch site',
      instructions: '',
      is_default: false,
      archived_at: null,
      artifact_count: 0,
      created_at: CREATED,
      updated_at: CREATED,
      ...o,
    });
  },

  /** The current version 1 of an HTML artifact. */
  version(o: Partial<VersionSummary> = {}): VersionSummary {
    return VersionSummary.parse({
      id: 'ver_1',
      number: 1,
      title: null,
      entry_path: 'index.html',
      theme_color: null,
      has_thumbnail: false,
      file_count: 1,
      total_bytes: 1_200,
      message: null,
      source: 'mcp',
      restored_from_version_id: null,
      warnings: [],
      created_by: 'usr_0000000000000000000a',
      created_at: CREATED,
      is_current: true,
      ...o,
    });
  },

  /** An HTML artifact in `prj_1` with one version; its links follow `id`. */
  artifact(o: Partial<ArtifactSummary> = {}): ArtifactSummary {
    const id = o.id ?? 'art_1';
    return ArtifactSummary.parse({
      id,
      project_id: 'prj_1',
      name: 'Homepage',
      kind: 'html',
      tags: [],
      current_version: fx.version(),
      latest_number: 1,
      open_thread_count: 0,
      share_link_count: 0,
      created_by: 'usr_0000000000000000000a',
      created_at: CREATED,
      updated_at: CREATED,
      links: {
        review: `http://localhost:3000/a/${id}`,
        raw: `http://localhost:3000/a/${id}/raw`,
      },
      ...o,
    });
  },

  /**
   * An open thread on version 1, pinned to a point; its first comment is by
   * the signed-in fixture user. `thread_id` follows `id`.
   */
  thread(o: Partial<CommentThread> = {}): CommentThread {
    const id = o.id ?? 'cmt_1';
    return CommentThread.parse({
      id,
      thread_id: id,
      artifact_id: 'art_1',
      version: { id: 'ver_1', number: 1 },
      author: { type: 'member', user_id: 'usr_0000000000000000000a', name: 'Ada Lovelace' },
      body: 'Make the heading larger.',
      created_at: CREATED,
      updated_at: CREATED,
      edited_at: null,
      anchor: {
        page: '/',
        kind: 'point',
        position: { x: 0.5, y: 0.25 },
        viewport: { width: 1280 },
      },
      status: 'open',
      resolved_in_version: null,
      resolved_by: null,
      resolved_at: null,
      replies: [],
      ...o,
    });
  },

  /** A reply by the fixture user in thread `cmt_1`. */
  comment(o: Partial<Comment> = {}): Comment {
    return Comment.parse({
      id: 'cmt_2',
      thread_id: 'cmt_1',
      artifact_id: 'art_1',
      version: { id: 'ver_1', number: 1 },
      author: { type: 'member', user_id: 'usr_0000000000000000000a', name: 'Ada Lovelace' },
      body: 'Agreed.',
      created_at: CREATED + 1_000,
      updated_at: CREATED + 1_000,
      edited_at: null,
      ...o,
    });
  },

  /** A review grant good for 12 hours from now. */
  grant(o: Partial<ContentGrant> = {}): ContentGrant {
    return ContentGrant.parse({
      url: 'https://content.example/g/grant-1/',
      mode: 'review',
      expires_at: Date.now() + 12 * 3_600_000,
      isolation: 'content-domain',
      ...o,
    });
  },

  /** An active link to the current version, open to anyone who has it, without comments. */
  shareLink(o: Partial<ShareLink> = {}): ShareLink {
    return ShareLink.parse({
      id: 'shl_1',
      artifact_id: 'art_1',
      version: null,
      has_password: false,
      allow_comments: false,
      expires_at: null,
      created_by: { user_id: 'usr_0000000000000000000a', name: 'Ada Lovelace' },
      created_at: CREATED,
      last_used_at: null,
      revoked_at: null,
      status: 'active',
      ...o,
    });
  },

  /**
   * What a link without comments shows: version 1 of an HTML artifact, as raw
   * files. With `allow_comments` its grant is a review grant, as the server
   * sends it.
   */
  shareInfo(o: Partial<ShareInfo> = {}): ShareInfo {
    const allowComments = o.allow_comments ?? false;
    return ShareInfo.parse({
      artifact_name: 'Homepage',
      kind: 'html',
      version_number: 1,
      follows_current: true,
      allow_comments: allowComments,
      expires_at: null,
      content: fx.grant({ mode: allowComments ? 'review' : 'raw' }),
      ...o,
    });
  },

  page<T>(items: T[], next: string | null = null): { items: T[]; next_cursor: string | null } {
    page(z.unknown()).parse({ items, next_cursor: next });
    return { items, next_cursor: next };
  },
};
