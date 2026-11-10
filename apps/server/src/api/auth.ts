import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../app.ts';
import { clearSessionCookie } from '../auth/session-cookie.ts';
import { deleteSession } from '../auth/sessions.ts';

const signOut = createRoute({
  method: 'post',
  path: '/auth/sign-out',
  tags: ['auth'],
  summary: 'End the browser session',
  description: 'Deletes the session the cookie names and clears the cookie. Tokens are untouched.',
  responses: {
    204: { description: 'Signed out, or there was nothing to end' },
  },
});

export function registerAuthRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(signOut, async (c) => {
    const { auth } = c.var;
    if (auth?.via === 'session' && auth.sessionId !== undefined) {
      await deleteSession(c.var.deps, auth.sessionId);
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });
}
