import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ErrorBody } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthContext } from '../app.ts';
import { authOf, requireSession } from '../auth/guards.ts';
import { idpAccessCurrent } from '../auth/oidc/gate.ts';
import { hasAccess } from '../auth/roles.ts';
import type { AppDeps } from '../deps.ts';
import { getArtifact } from '../domain/artifacts.ts';
import { ARTIFACT_TOPIC } from '../domain/search.ts';
import { liveStream } from '../http/sse.ts';
import { IdParam } from './pagination.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/** What both streams answer with, for the API document. */
export const EVENT_STREAM_CONTENT = {
  'text/event-stream': {
    schema: z
      .string()
      .describe(
        'Server-sent events: `retry: 5000` first, then one `event: <type>` and `data: <LiveEvent as JSON>` per change, and a `: ping` comment every 25 seconds',
      ),
  },
};

const eventsRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/events',
  tags: ['live updates'],
  summary: 'Follow the changes to an artifact',
  description:
    'A stream of new and deleted versions and comment changes, for `EventSource`. Browser sessions only: API tokens get 403. Access is checked again at every heartbeat, so the stream ends within 25 seconds of the session ending or access being taken away; it also ends after `artifact.deleted`. After a reconnect, read the threads again: events sent while disconnected are not replayed.',
  middleware: [requireSession] as MiddlewareHandler<AppEnv>[],
  security: [{ session: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: 'The event stream', content: EVENT_STREAM_CONTENT },
    401: error('Not signed in'),
    403: error('A bearer token was used; live updates need a browser session (`forbidden`)'),
    404: error('The artifact does not exist (`not_found`)'),
    410: error('The artifact was deleted (`gone`)'),
  },
});

/**
 * Whether the member stream of `auth` on artifact `artifactId` may go on: the session is still
 * there and not expired, its user still has access (role, not blocked or disabled, a recent
 * enough IdP check), and the artifact still exists.
 */
async function memberStillAllowed(
  deps: AppDeps,
  auth: AuthContext,
  artifactId: string,
): Promise<boolean> {
  const { db } = deps.db;
  const now = deps.clock.now();
  if (auth.sessionId === undefined) return false;
  const session = await db
    .selectFrom('sessions')
    .select('user_id')
    .where('id_hash', '=', auth.sessionId)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (session === undefined) return false;
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', session.user_id)
    .executeTakeFirst();
  if (user === undefined || !hasAccess(user) || !idpAccessCurrent(user, now, deps.config)) {
    return false;
  }
  const artifact = await db
    .selectFrom('artifacts')
    .select('id')
    .where('id', '=', artifactId)
    .executeTakeFirst();
  return artifact !== undefined;
}

/** Live updates for members; share viewers have theirs in `share-public.ts`. */
export function registerEventRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(eventsRoute, async (c) => {
    const { deps } = c.var;
    const auth = authOf(c);
    const artifact = await getArtifact(deps.db.db, c.req.valid('param').id, deps.clock.now());
    return liveStream(c, {
      topic: ARTIFACT_TOPIC(artifact.id),
      forward: (e) => (e.type === 'artifact.deleted' ? 'send-and-close' : 'send'),
      stillAllowed: () => memberStillAllowed(deps, auth, artifact.id),
    });
  });
}
