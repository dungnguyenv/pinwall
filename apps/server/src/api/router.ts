import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../app.ts';
import { publicUrl } from '../http/public-url.ts';
import { badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { registerAccountRoutes } from './account.ts';
import { registerAdminConfigRoutes } from './admin-config.ts';
import { registerAdminUserRoutes } from './admin-users.ts';
import { registerArtifactRoutes } from './artifacts.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerCommentRoutes } from './comments.ts';
import { registerConfigRoutes } from './config.ts';
import { registerContentRoutes } from './content.ts';
import { registerDiffRoutes } from './diff.ts';
import { registerMeRoutes } from './me.ts';
import { registerProjectRoutes } from './projects.ts';
import { registerPublishRoutes } from './publish.ts';
import { registerSetupRoutes } from './setup.ts';
import { registerTokenRoutes } from './tokens.ts';
import { registerVersionRoutes } from './versions.ts';

/**
 * A bare API router: a body or parameter that fails its schema becomes a `bad_request` listing
 * each problem, in the same error format as everything else.
 */
export function createApiRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw badRequest(t('error.validation'), {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
    },
  });
}

/**
 * The router mounted at `/api/v1`. Every resource module adds one `registerXRoutes(api)` line
 * below; the OpenAPI document at `/openapi.json` lists whatever has been registered.
 */
export function buildApiRouter(): OpenAPIHono<AppEnv> {
  const api = createApiRouter();

  api.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'A personal API token, sent as `Authorization: Bearer <token>`.',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'pinwall_session',
    description:
      'The browser session cookie. On an https origin it is named `__Host-pinwall_session`.',
  });
  api.doc31('/openapi.json', (c) => ({
    openapi: '3.1.0',
    info: { title: 'Pinwall API', version: '1' },
    servers: [{ url: publicUrl(c.var.deps.config, '/api/v1') }],
  }));

  registerConfigRoutes(api);
  registerMeRoutes(api);
  registerAccountRoutes(api);
  registerAuthRoutes(api);
  registerSetupRoutes(api);
  registerTokenRoutes(api);
  registerAdminUserRoutes(api);
  registerAdminConfigRoutes(api);
  registerPublishRoutes(api);
  registerProjectRoutes(api);
  registerArtifactRoutes(api);
  registerVersionRoutes(api);
  registerContentRoutes(api);
  registerDiffRoutes(api);
  registerCommentRoutes(api);

  return api;
}
