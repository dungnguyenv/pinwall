import type { RateRule } from '../auth/rate-limits.ts';

/** The only scope Pinwall issues: everything the signed-in person may do through `/mcp`. */
export const OAUTH_SCOPE = 'pinwall';

export const ACCESS_TOKEN_PREFIX = 'pwa_';
export const REFRESH_TOKEN_PREFIX = 'pwr_';

export const ACCESS_TOKEN_TTL_MS = 3_600_000;
/** Refresh tokens rotate: each use issues a new one with a full lifetime. */
export const REFRESH_TOKEN_TTL_MS = 2_592_000_000;
/** How long an authorization request waits for the person to sign in and decide. */
export const AUTH_REQUEST_TTL_MS = 600_000;
/** Authorization codes are single use and live this long. */
export const AUTH_CODE_TTL_MS = 60_000;
/** A redeemed code is remembered this long, so a replay can be recognized. */
export const USED_CODE_TTL_MS = 600_000;
/** A registered client unused this long is deleted, with its grants and tokens. */
export const CLIENT_IDLE_MS = 2_592_000_000;
export const OAUTH_CLEANUP_PERIOD_MS = 3_600_000;
/** A grant's `last_used_at` is written at most this often. */
export const GRANT_TOUCH_INTERVAL_MS = 60_000;

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_STATE_LENGTH = 1024;
/** In code points, after `cleanClientName`. */
export const MAX_CLIENT_NAME = 100;

/** Per client address. */
export const OAUTH_RATES: {
  register: RateRule;
  authorize: RateRule;
  token: RateRule;
  revoke: RateRule;
} = {
  register: { name: 'oauth-register', limit: 30, windowMs: 3_600_000 },
  authorize: { name: 'oauth-authorize', limit: 60, windowMs: 600_000 },
  token: { name: 'oauth-token', limit: 120, windowMs: 600_000 },
  revoke: { name: 'oauth-revoke', limit: 120, windowMs: 600_000 },
};
