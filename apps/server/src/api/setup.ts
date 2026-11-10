import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CeremonyOptions,
  ErrorBody,
  Me,
  SetupPasskeyOptionsRequest,
  SetupRequest,
  SetupTokenRequest,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { authOf } from '../auth/guards.ts';
import { RATE_RULES, rateLimit } from '../auth/rate-limits.ts';
import { startSession } from '../auth/session-cookie.ts';
import { beginSetupPasskey, checkSetupToken, completeSetup } from '../auth/setup.ts';
import { toMe } from '../auth/users.ts';
import { jsonBodyLimit } from './body-limit.ts';

/** Every setup route counts the attempt first, then caps the body. */
const middleware: MiddlewareHandler<AppEnv>[] = [rateLimit(RATE_RULES.setup), jsonBodyLimit];

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const linkErrors = {
  403: error('The setup link is invalid or has expired'),
  409: error('Setup is already complete (`setup_done`)'),
  429: error('Too many setup attempts from this address'),
};

const checkLink = createRoute({
  method: 'post',
  path: '/auth/setup/check',
  tags: ['auth'],
  summary: 'Check a setup link before showing the setup form',
  middleware,
  request: { body: jsonBody(SetupTokenRequest) },
  responses: {
    204: { description: 'The link works' },
    ...linkErrors,
  },
});

const setupPasskeyOptions = createRoute({
  method: 'post',
  path: '/auth/setup/passkey/options',
  tags: ['auth'],
  summary: "Begin registering the owner's first passkey",
  description: 'Returns WebAuthn creation options; send the result with `POST /auth/setup`.',
  middleware,
  request: { body: jsonBody(SetupPasskeyOptionsRequest) },
  responses: {
    200: {
      description: 'Options for `navigator.credentials.create()`',
      content: { 'application/json': { schema: CeremonyOptions } },
    },
    400: error('Passkeys cannot work at this public origin'),
    ...linkErrors,
  },
});

const setup = createRoute({
  method: 'post',
  path: '/auth/setup',
  tags: ['auth'],
  summary: 'Create the owner account and sign in',
  description:
    'Needs a password, a passkey or both. The setup link stops working once this succeeds.',
  middleware,
  request: { body: jsonBody(SetupRequest) },
  responses: {
    201: {
      description: 'The owner, signed in with a new session cookie',
      content: { 'application/json': { schema: Me } },
    },
    400: error('No credential, or a password that is too short or too long'),
    401: error('The passkey could not be verified (`invalid_credentials`)'),
    ...linkErrors,
  },
});

export function registerSetupRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(checkLink, async (c) => {
    await checkSetupToken(c.var.deps, c.req.valid('json').token);
    return c.body(null, 204);
  });

  api.openapi(setupPasskeyOptions, async (c) => {
    const { token, name } = c.req.valid('json');
    const { ceremonyId, options } = await beginSetupPasskey(c.var.deps, token, name);
    return c.json({ ceremony_id: ceremonyId, options }, 200, { 'Cache-Control': 'no-store' });
  });

  api.openapi(setup, async (c) => {
    const body = c.req.valid('json');
    const { deps } = c.var;
    const user = await completeSetup(deps, {
      token: body.token,
      name: body.name,
      email: body.email ?? null,
      password: body.password ?? null,
      passkey: body.passkey
        ? {
            ceremonyId: body.passkey.ceremony_id,
            response: body.passkey.response,
            name: body.passkey.name ?? null,
          }
        : null,
    });
    await startSession(c, user, body.passkey ? 'passkey' : 'password');
    return c.json(await toMe(deps, authOf(c)), 201, { 'Cache-Control': 'no-store' });
  });
}
