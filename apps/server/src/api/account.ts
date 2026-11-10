import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AddPasskeyRequest,
  CeremonyOptions,
  ChangePasswordRequest,
  ErrorBody,
  Me,
  Passkey,
  PasskeyList,
  RenamePasskeyRequest,
  UpdateProfileRequest,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import {
  addPasskey,
  beginAddPasskey,
  changePassword,
  deletePasskey,
  passkeyTransports,
  removePassword,
  renamePasskey,
  updateProfile,
} from '../auth/account.ts';
import { authOf, requireAuth, requireOwner, requireSession } from '../auth/guards.ts';
import { listPasskeys } from '../auth/passkeys.ts';
import { RATE_RULES, rateLimit } from '../auth/rate-limits.ts';
import { toMe } from '../auth/users.ts';
import type { PasskeyRow } from '../db/schema.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
});

/**
 * Who may call. Reading and profile changes take any sign-in of the owner. Changing how the
 * owner signs in takes a browser session: a token must never be able to add a way in or remove
 * one. The session guard comes first, so a token is told that, not "owner only".
 */
const ownerAny: MiddlewareHandler<AppEnv>[] = [requireAuth, requireOwner];
const ownerSession: MiddlewareHandler<AppEnv>[] = [requireSession, requireOwner];

const anySecurity: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const sessionSecurity: Record<string, string[]>[] = [{ session: [] }];

const ownerErrors = {
  401: error('Not signed in'),
  403: error('Not the owner account (`forbidden`)'),
};
const sessionErrors = {
  401: ownerErrors[401],
  403: error('Not a browser session of the owner account (`forbidden`)'),
};

const PasskeyId = z.object({ id: z.string().min(1).max(100) });

const patchMe = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['account'],
  summary: 'Update the owner profile',
  description: 'Fields left out stay as they are; `email: null` removes the email.',
  middleware: [...ownerAny, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security: anySecurity,
  request: { body: jsonBody(UpdateProfileRequest) },
  responses: {
    200: { description: 'The updated owner', content: { 'application/json': { schema: Me } } },
    ...ownerErrors,
  },
});

const putPassword = createRoute({
  method: 'put',
  path: '/me/password',
  tags: ['account'],
  summary: 'Set or change the owner password',
  description:
    'With a password already set, `current_password` must be it. Every other browser session ends and this one stays; API tokens are not touched.',
  middleware: [
    ...ownerSession,
    rateLimit(RATE_RULES.password),
    jsonBodyLimit,
  ] as MiddlewareHandler<AppEnv>[],
  security: sessionSecurity,
  request: { body: jsonBody(ChangePasswordRequest) },
  responses: {
    204: { description: 'The password is set' },
    400: error('The new password is too short or too long'),
    401: error('The current password is missing or wrong (`invalid_credentials`)'),
    403: sessionErrors[403],
    429: error('Too many attempts'),
  },
});

const deletePasswordRoute = createRoute({
  method: 'delete',
  path: '/me/password',
  tags: ['account'],
  summary: 'Remove the owner password',
  description: 'Refused while the owner has no passkey: it would be their last way to sign in.',
  middleware: ownerSession,
  security: sessionSecurity,
  responses: {
    204: { description: 'The owner has no password now' },
    ...sessionErrors,
    409: error('It is the last way to sign in (`conflict`)'),
  },
});

const listOwnPasskeys = createRoute({
  method: 'get',
  path: '/me/passkeys',
  tags: ['account'],
  summary: "List the owner's passkeys",
  description: 'Oldest first.',
  middleware: ownerAny,
  security: anySecurity,
  responses: {
    200: { description: 'The passkeys', content: { 'application/json': { schema: PasskeyList } } },
    ...ownerErrors,
  },
});

const passkeyOptions = createRoute({
  method: 'post',
  path: '/me/passkeys/options',
  tags: ['account'],
  summary: 'Begin adding a passkey',
  description:
    'Returns WebAuthn creation options that exclude the passkeys the owner has; send the result with `POST /me/passkeys`.',
  middleware: ownerSession,
  security: sessionSecurity,
  responses: {
    200: {
      description: 'Options for `navigator.credentials.create()`',
      content: { 'application/json': { schema: CeremonyOptions } },
    },
    400: error('Passkeys cannot work at this public origin'),
    ...sessionErrors,
  },
});

const addOwnPasskey = createRoute({
  method: 'post',
  path: '/me/passkeys',
  tags: ['account'],
  summary: 'Finish adding a passkey',
  description: 'Without a `name`, the passkey is called "Passkey <n>".',
  middleware: [...ownerSession, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security: sessionSecurity,
  request: { body: jsonBody(AddPasskeyRequest) },
  responses: {
    201: { description: 'The new passkey', content: { 'application/json': { schema: Passkey } } },
    401: error('The passkey could not be verified (`invalid_credentials`)'),
    403: sessionErrors[403],
    409: error('This credential is registered already (`conflict`)'),
  },
});

const renameOwnPasskey = createRoute({
  method: 'patch',
  path: '/me/passkeys/{id}',
  tags: ['account'],
  summary: 'Rename a passkey',
  middleware: [...ownerSession, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security: sessionSecurity,
  request: { params: PasskeyId, body: jsonBody(RenamePasskeyRequest) },
  responses: {
    200: { description: 'The passkey', content: { 'application/json': { schema: Passkey } } },
    ...sessionErrors,
    404: error('Not one of your passkeys (`not_found`)'),
  },
});

const deleteOwnPasskey = createRoute({
  method: 'delete',
  path: '/me/passkeys/{id}',
  tags: ['account'],
  summary: 'Delete a passkey',
  description: 'Refused when it is the last way to sign in.',
  middleware: ownerSession,
  security: sessionSecurity,
  request: { params: PasskeyId },
  responses: {
    204: { description: 'Deleted' },
    ...sessionErrors,
    404: error('Not one of your passkeys (`not_found`)'),
    409: error('It is the last way to sign in (`conflict`)'),
  },
});

function toPasskey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    name: row.name,
    transports: passkeyTransports(row),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerAccountRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(patchMe, async (c) => {
    const { deps } = c.var;
    const auth = authOf(c);
    const { name, email } = c.req.valid('json');
    const user = await updateProfile(deps, auth.user.id, { name, email });
    return c.json(await toMe(deps, { ...auth, user }), 200, noStore);
  });

  api.openapi(putPassword, async (c) => {
    const body = c.req.valid('json');
    await changePassword(c.var.deps, authOf(c), {
      current: body.current_password ?? null,
      next: body.new_password,
    });
    return c.body(null, 204);
  });

  api.openapi(deletePasswordRoute, async (c) => {
    await removePassword(c.var.deps, authOf(c).user.id);
    return c.body(null, 204);
  });

  api.openapi(listOwnPasskeys, async (c) => {
    const rows = await listPasskeys(c.var.deps.db.db, authOf(c).user.id);
    return c.json({ items: rows.map(toPasskey), next_cursor: null }, 200, noStore);
  });

  api.openapi(passkeyOptions, async (c) => {
    const { ceremonyId, options } = await beginAddPasskey(c.var.deps, authOf(c).user);
    return c.json({ ceremony_id: ceremonyId, options }, 200, noStore);
  });

  api.openapi(addOwnPasskey, async (c) => {
    const body = c.req.valid('json');
    const row = await addPasskey(c.var.deps, authOf(c).user, {
      ceremonyId: body.ceremony_id,
      response: body.response,
      name: body.name ?? null,
    });
    return c.json(toPasskey(row), 201, noStore);
  });

  api.openapi(renameOwnPasskey, async (c) => {
    const row = await renamePasskey(
      c.var.deps,
      authOf(c).user.id,
      c.req.valid('param').id,
      c.req.valid('json').name,
    );
    return c.json(toPasskey(row), 200, noStore);
  });

  api.openapi(deleteOwnPasskey, async (c) => {
    await deletePasskey(c.var.deps, authOf(c).user.id, c.req.valid('param').id);
    return c.body(null, 204);
  });
}
