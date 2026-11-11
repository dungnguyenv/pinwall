import { z } from 'zod';
import { ArtifactSummary, Me, Project, PublicConfig, page, VersionSummary } from '../api/dto.ts';

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

  page<T>(items: T[], next: string | null = null): { items: T[]; next_cursor: string | null } {
    page(z.unknown()).parse({ items, next_cursor: next });
    return { items, next_cursor: next };
  },
};
