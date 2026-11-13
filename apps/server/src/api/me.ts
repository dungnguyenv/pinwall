import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ErrorBody, Me, PurgeRequest, PurgeResult } from '@pinwall/shared';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth, requireSession } from '../auth/guards.ts';
import { toMe } from '../auth/users.ts';
import { assertPurgeConfirmed, purgeOwnSpace } from '../domain/purge.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { personalOnly } from './personal-only.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

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
    401: error('Not signed in'),
  },
});

const purgeMe = createRoute({
  method: 'post',
  path: '/me/purge',
  tags: ['account'],
  summary: 'Delete all of your content',
  description:
    'Only in `personal` mode (in `team` mode the route does not exist: `not_found`, whoever asks), and only from a browser session, never with a token. Deletes every project you own, with all that is in them: your share links answer "gone" and the files are removed. Projects you only belong to stay, and so does your account. Send your email address (your id, when you have none) as `confirm_email`. This cannot be undone.',
  middleware: [personalOnly, requireAuth, requireSession, jsonBodyLimit] as const,
  security: [{ session: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: PurgeRequest } } },
  },
  responses: {
    200: {
      description: 'What was deleted',
      content: { 'application/json': { schema: PurgeResult } },
    },
    400: error('`confirm_email` is not your email address'),
    401: error('Not signed in'),
    403: error('Signed in with a token rather than a browser session (`forbidden`)'),
    404: error('The instance is in `team` mode (`not_found`)'),
    409: error('New artifacts kept arriving; try again (`conflict`)'),
  },
});

const noStore = { 'Cache-Control': 'no-store' };

export function registerMeRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(getMe, async (c) => {
    const me = await toMe(c.var.deps, authOf(c));
    return c.json(me, 200, noStore);
  });

  api.openapi(purgeMe, async (c) => {
    const { deps } = c.var;
    const { user } = authOf(c);
    const { confirm_email } = c.req.valid('json');
    assertPurgeConfirmed(user, confirm_email);
    deps.logger.info({ user_id: user.id, action: 'self.purge' }, 'moderation');
    return c.json(await purgeOwnSpace(deps, user), 200, noStore);
  });
}
