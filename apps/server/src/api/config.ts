import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { PublicConfig } from '@pinwall/shared';
import type { AppEnv } from '../app.ts';
import { ownerExists } from '../auth/users.ts';
import { passkeysAvailable } from '../auth/webauthn.ts';

const publicConfig = createRoute({
  method: 'get',
  path: '/config/public',
  tags: ['config'],
  summary: 'Read what the sign-in and setup screens need',
  responses: {
    200: {
      description: 'Instance settings that are safe to show to anyone',
      content: { 'application/json': { schema: PublicConfig } },
    },
  },
});

export function registerConfigRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(publicConfig, async (c) => {
    const { config, db } = c.var.deps;
    const body: PublicConfig = {
      setup_required: !(await ownerExists(db.db)),
      oidc: config.oidc
        ? { enabled: true, display_name: config.oidc.displayName }
        : { enabled: false, display_name: null },
      isolation: config.isolation.mode,
      passkeys_available: passkeysAvailable(config),
      // New fields are sent only in personal mode: a team instance answers as 1.0 did.
      ...(config.visibility === 'personal' ? { visibility: 'personal' as const } : {}),
      limits: {
        max_upload_bytes: config.limits.maxUploadBytes,
        max_inline_bytes: config.limits.maxInlineBytes,
        max_file_bytes: config.limits.maxFileBytes,
        max_version_bytes: config.limits.maxVersionBytes,
        max_files: config.limits.maxFiles,
        max_expansion_ratio: config.limits.maxExpansionRatio,
      },
    };
    // Setup flips `setup_required`, so a cached answer would send people to a finished setup.
    return c.json(body, 200, { 'Cache-Control': 'no-store' });
  });
}
