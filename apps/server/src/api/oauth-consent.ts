import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  ErrorBody,
  OAuthConsentRequest,
  OAuthDecisionRequest,
  OAuthDecisionResult,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { authOf, requireSession } from '../auth/guards.ts';
import { decideConsentRequest, getConsentRequest } from '../oauth/requests.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/**
 * Only a person in a browser may let an agent act as them: tokens, OAuth ones included, never
 * can. The guard runs before the body is read, and `/api/v1`'s origin check already refuses a
 * decision posted from another site.
 */
const security = [{ session: [] }];
const errors = {
  401: error('Not signed in'),
  403: error('A bearer token was used, or the decision came from another origin (`forbidden`)'),
  404: error('The request expired, was already answered or never existed (`not_found`)'),
};

const RequestParams = z.object({
  id: z.string().min(1).max(256).openapi({ description: 'The `request` of the consent page URL' }),
});

const noStore = { 'Cache-Control': 'no-store' };

const describeRequest = createRoute({
  method: 'get',
  path: '/oauth/requests/{id}',
  tags: ['oauth'],
  summary: 'Describe a pending authorization request',
  description:
    'Who asks (the name the client registered, unverified), where the answer goes, which scopes, and for whom: the person signed in now.',
  middleware: [requireSession] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: RequestParams },
  responses: {
    200: {
      description: 'The request',
      content: { 'application/json': { schema: OAuthConsentRequest } },
    },
    ...errors,
  },
});

const decide = createRoute({
  method: 'post',
  path: '/oauth/requests/{id}/decision',
  tags: ['oauth'],
  summary: 'Allow or deny a pending authorization request',
  description:
    'Uses the request up. The browser then goes to `redirect_to`: the client’s redirect URI with a single-use code, or with `error=access_denied`.',
  middleware: [requireSession, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: RequestParams,
    body: { required: true, content: { 'application/json': { schema: OAuthDecisionRequest } } },
  },
  responses: {
    200: {
      description: 'Where the browser goes next',
      content: { 'application/json': { schema: OAuthDecisionResult } },
    },
    ...errors,
  },
});

export function registerOAuthConsentRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(describeRequest, async (c) => {
    const { id } = c.req.valid('param');
    const request = await getConsentRequest(c.var.deps, authOf(c).user, id);
    return c.json(request, 200, noStore);
  });

  api.openapi(decide, async (c) => {
    const { id } = c.req.valid('param');
    const { approve } = c.req.valid('json');
    const result = await decideConsentRequest(c.var.deps, authOf(c).user, id, approve);
    return c.json(result, 200, noStore);
  });
}
