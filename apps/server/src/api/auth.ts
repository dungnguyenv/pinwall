import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CeremonyOptions,
  ErrorBody,
  Me,
  PasskeySignInRequest,
  PasswordSignInRequest,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { authOf } from '../auth/guards.ts';
import {
  beginPasskeySignIn,
  signInWithPasskey,
  signInWithPassword,
} from '../auth/owner-sign-in.ts';
import { RATE_RULES, rateLimit } from '../auth/rate-limits.ts';
import { clearSessionCookie, startSession } from '../auth/session-cookie.ts';
import { deleteSession } from '../auth/sessions.ts';
import { toMe } from '../auth/users.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const signedIn = {
  description: 'The owner, signed in with a new session cookie',
  content: { 'application/json': { schema: Me } },
};

const signInErrors = {
  403: error('The owner account is blocked (`access_denied`)'),
  409: error('Pinwall is not set up yet (`setup_required`)'),
  429: error('Too many attempts'),
};

/** Per address first, so one address cannot use up the limit every address shares. */
const passwordMiddleware: MiddlewareHandler<AppEnv>[] = [
  rateLimit(RATE_RULES.password),
  rateLimit(RATE_RULES.passwordGlobal, 'all'),
  jsonBodyLimit,
];

const passwordSignIn = createRoute({
  method: 'post',
  path: '/auth/password/sign-in',
  tags: ['auth'],
  summary: 'Sign in to the owner account with its password',
  middleware: passwordMiddleware,
  request: {
    body: { required: true, content: { 'application/json': { schema: PasswordSignInRequest } } },
  },
  responses: {
    200: signedIn,
    401: error('Wrong password (`invalid_credentials`)'),
    ...signInErrors,
  },
});

const passkeyOptions = createRoute({
  method: 'post',
  path: '/auth/passkey/options',
  tags: ['auth'],
  summary: 'Begin signing in with a passkey',
  description:
    'Returns WebAuthn request options for any passkey of the owner; send the result with `POST /auth/passkey/sign-in`.',
  middleware: [rateLimit(RATE_RULES.passkey)],
  responses: {
    200: {
      description: 'Options for `navigator.credentials.get()`',
      content: { 'application/json': { schema: CeremonyOptions } },
    },
    400: error('Passkeys cannot work at this public origin'),
    409: signInErrors[409],
    429: signInErrors[429],
  },
});

const passkeySignIn = createRoute({
  method: 'post',
  path: '/auth/passkey/sign-in',
  tags: ['auth'],
  summary: 'Sign in to the owner account with a passkey',
  middleware: [rateLimit(RATE_RULES.passkey), jsonBodyLimit],
  request: {
    body: { required: true, content: { 'application/json': { schema: PasskeySignInRequest } } },
  },
  responses: {
    200: signedIn,
    401: error('The passkey could not be verified (`invalid_credentials`)'),
    403: signInErrors[403],
    429: signInErrors[429],
  },
});

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
  api.openapi(passwordSignIn, async (c) => {
    const { deps } = c.var;
    const owner = await signInWithPassword(deps, c.req.valid('json').password);
    await startSession(c, owner, 'password');
    return c.json(await toMe(deps, authOf(c)), 200, { 'Cache-Control': 'no-store' });
  });

  api.openapi(passkeyOptions, async (c) => {
    const { ceremonyId, options } = await beginPasskeySignIn(c.var.deps);
    return c.json({ ceremony_id: ceremonyId, options }, 200, { 'Cache-Control': 'no-store' });
  });

  api.openapi(passkeySignIn, async (c) => {
    const { deps } = c.var;
    const { ceremony_id, response } = c.req.valid('json');
    const owner = await signInWithPasskey(deps, ceremony_id, response);
    await startSession(c, owner, 'passkey');
    return c.json(await toMe(deps, authOf(c)), 200, { 'Cache-Control': 'no-store' });
  });

  api.openapi(signOut, async (c) => {
    const { auth } = c.var;
    if (auth?.via === 'session' && auth.sessionId !== undefined) {
      await deleteSession(c.var.deps, auth.sessionId);
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  });
}
