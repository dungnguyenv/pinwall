import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  type ApiToken,
  ApiTokenList,
  CreateApiTokenRequest,
  CreatedApiToken,
  ErrorBody,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { createApiToken, listApiTokens, revokeApiToken } from '../auth/api-tokens.ts';
import { authOf, requireSession } from '../auth/guards.ts';
import type { ApiTokenRow } from '../db/schema.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/**
 * Tokens are managed from a browser session only: a leaked token must not be able to mint or
 * revoke tokens. The guard runs before the body is read.
 */
const security = [{ session: [] }];
const guardErrors = {
  401: error('Not signed in'),
  403: error('A bearer token was used; tokens cannot manage tokens (`forbidden`)'),
};
const guarded: MiddlewareHandler<AppEnv>[] = [requireSession];

const TokenId = z.object({ id: z.string().min(1).max(100) });

const listTokens = createRoute({
  method: 'get',
  path: '/me/tokens',
  tags: ['account'],
  summary: 'List your API tokens',
  description: 'Tokens that are not revoked, newest first. Secrets are never listed.',
  middleware: guarded,
  security,
  responses: {
    200: {
      description: 'Your tokens',
      content: { 'application/json': { schema: ApiTokenList } },
    },
    ...guardErrors,
  },
});

const createToken = createRoute({
  method: 'post',
  path: '/me/tokens',
  tags: ['account'],
  summary: 'Create an API token',
  description:
    'The response carries the secret, the only time it is shown. Send it as `Authorization: Bearer <secret>`.',
  middleware: [requireSession, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateApiTokenRequest } } },
  },
  responses: {
    201: {
      description: 'The new token and its secret',
      content: { 'application/json': { schema: CreatedApiToken } },
    },
    ...guardErrors,
    409: error('You already hold the maximum of active tokens (`conflict`)'),
  },
});

const revokeToken = createRoute({
  method: 'delete',
  path: '/me/tokens/{id}',
  tags: ['account'],
  summary: 'Revoke an API token',
  description: 'The token stops working at once.',
  middleware: guarded,
  security,
  request: { params: TokenId },
  responses: {
    204: { description: 'Revoked' },
    ...guardErrors,
    404: error('Not one of your tokens, or already revoked (`not_found`)'),
  },
});

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
  };
}

export function registerTokenRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listTokens, async (c) => {
    const rows = await listApiTokens(c.var.deps, authOf(c).user.id);
    return c.json({ items: rows.map(toApiToken), next_cursor: null }, 200, {
      'Cache-Control': 'no-store',
    });
  });

  api.openapi(createToken, async (c) => {
    const body = c.req.valid('json');
    const { row, secret } = await createApiToken(c.var.deps, authOf(c).user.id, {
      name: body.name,
      expiresInDays: body.expires_in_days ?? null,
    });
    return c.json({ token: toApiToken(row), secret }, 201, { 'Cache-Control': 'no-store' });
  });

  api.openapi(revokeToken, async (c) => {
    await revokeApiToken(c.var.deps, authOf(c).user.id, c.req.valid('param').id);
    return c.body(null, 204);
  });
}
