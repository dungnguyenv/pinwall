import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ErrorBody, ShareInfo, UnlockRequest } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { readUnlockCookie, resolveShare, shareInfo, unlockShare } from '../domain/share-access.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/** The share token from the link: not validated here, an unknown one is a 404. */
const TokenParam = z.object({ token: z.string() });

const linkErrors = {
  404: error('No share link has this token (`not_found`)'),
  410: error(
    'The link was revoked, expired, or deleted with what it shared (`gone`, `details.reason` `revoked`, `expired` or `deleted`)',
  ),
};

const infoRoute = createRoute({
  method: 'get',
  path: '/share/{token}',
  tags: ['share viewer'],
  summary: 'Open a share link',
  description:
    'What the share viewer shows: the artifact name, the version and a new content URL to it, `review` when the link allows comments and `raw` otherwise. Needs no account; a link with a password needs the unlock cookie set by `POST /share/{token}/unlock`.',
  request: { params: TokenParam },
  responses: {
    200: {
      description: 'The shared version and a content URL to it',
      content: { 'application/json': { schema: ShareInfo } },
    },
    401: error(
      'The link has a password and this browser has not unlocked it (`unauthorized`, `details.password_required`)',
    ),
    ...linkErrors,
  },
});

const unlockRoute = createRoute({
  method: 'post',
  path: '/share/{token}/unlock',
  tags: ['share viewer'],
  summary: 'Unlock a share link with its password',
  description:
    'Sets the unlock cookie for this link, for 24 hours or until the link expires, whichever comes first; then reload `/s/{token}`. A link without a password needs nothing and sets nothing. Attempts are limited per link, from each address and in total.',
  middleware: [jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  request: {
    params: TokenParam,
    body: { required: true, content: { 'application/json': { schema: UnlockRequest } } },
  },
  responses: {
    204: { description: 'Unlocked' },
    400: error('An invalid body'),
    401: error('Wrong password (`invalid_credentials`)'),
    403: error('A cross-site request (`forbidden`)'),
    ...linkErrors,
    429: error('Too many attempts on this link (`rate_limited`)'),
  },
});

const noStore = { 'Cache-Control': 'no-store' };

/** The share viewer's API: authorized by the share token and the unlock cookie, never by an account. */
export function registerSharePublicRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(infoRoute, async (c) => {
    const { deps } = c.var;
    const s = await resolveShare(deps, c.req.valid('param').token, readUnlockCookie(c));
    return c.json(await shareInfo(deps, s), 200, noStore);
  });

  api.openapi(unlockRoute, async (c) => {
    await unlockShare(c, c.req.valid('param').token, c.req.valid('json').password);
    return c.body(null, 204, noStore);
  });
}
