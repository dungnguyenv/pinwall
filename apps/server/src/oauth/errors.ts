import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { AppError } from '../lib/errors.ts';

/** Error codes of RFC 6749 §5.2, RFC 7591 §3.2.2 and RFC 8707 §2 that Pinwall answers with. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_target'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'temporarily_unavailable';

/** A refusal of an OAuth endpoint, answered as `{ error, error_description }` by `oauthJson`. */
export class OAuthError extends Error {
  override readonly name = 'OAuthError';

  constructor(
    readonly error: OAuthErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): 400 | 401 | 429 {
    if (this.error === 'invalid_client') return 401;
    if (this.error === 'temporarily_unavailable') return 429;
    return 400;
  }
}

interface OAuthRefusal {
  status: 400 | 401 | 413 | 429;
  error: OAuthErrorCode;
  description: string;
  retryAfterSeconds?: number;
}

/** How an OAuth endpoint answers `err`, or null when the app's error handler should. */
function refusalFor(err: unknown): OAuthRefusal | null {
  if (err instanceof OAuthError) {
    return { status: err.status, error: err.error, description: err.message };
  }
  if (!(err instanceof AppError)) return null;
  if (err.code === 'rate_limited') {
    const retryAfter = err.details?.retry_after_seconds;
    return {
      status: 429,
      error: 'temporarily_unavailable',
      description: err.message,
      ...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {}),
    };
  }
  if (err.code === 'payload_too_large') {
    return { status: 413, error: 'invalid_request', description: err.message };
  }
  return null;
}

/**
 * Wraps a handler of `/oauth/register`, `/oauth/token` or `/oauth/revoke` so its refusals are
 * RFC 6749 JSON, `{ error, error_description }`, whatever `Accept` says: an `OAuthError` with its
 * own status; the rate limit as 429 `temporarily_unavailable` with `Retry-After`; a body over
 * its limit as 413 `invalid_request`. Every answer, success or not, is `Cache-Control: no-store`.
 * Anything else is rethrown to the app's error handler.
 */
export function oauthJson(
  handler: (c: Context<AppEnv>) => Promise<Response>,
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      return await handler(c);
    } catch (err) {
      const refusal = refusalFor(err);
      if (!refusal) throw err;
      if (refusal.retryAfterSeconds !== undefined) {
        c.header('Retry-After', String(refusal.retryAfterSeconds));
      }
      return c.json(
        { error: refusal.error, error_description: refusal.description },
        refusal.status,
      );
    }
  };
}
