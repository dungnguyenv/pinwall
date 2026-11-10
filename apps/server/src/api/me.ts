import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ErrorBody, Me } from '@pinwall/shared';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import { toMe } from '../auth/users.ts';

const getMe = createRoute({
  method: 'get',
  path: '/me',
  tags: ['account'],
  summary: 'Read the signed-in user',
  middleware: [requireAuth] as const,
  security: [{ session: [] }, { bearer: [] }],
  responses: {
    200: {
      description: 'The signed-in user, and how this request was authenticated',
      content: { 'application/json': { schema: Me } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

export function registerMeRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(getMe, async (c) => {
    const me = await toMe(c.var.deps, authOf(c));
    return c.json(me, 200, { 'Cache-Control': 'no-store' });
  });
}
