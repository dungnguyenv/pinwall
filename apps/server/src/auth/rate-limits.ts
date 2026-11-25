import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppDeps } from '../deps.ts';
import { clientIp } from '../http/client-ip.ts';
import { rateLimited } from '../lib/errors.ts';
import { authOf } from './guards.ts';

/** At most `limit` attempts per `windowMs` for each key; `name` keeps rules' counters apart. */
export interface RateRule {
  name: string;
  limit: number;
  windowMs: number;
}

export const RATE_RULES: {
  setup: RateRule;
  password: RateRule;
  passwordGlobal: RateRule;
  passkey: RateRule;
  publish: RateRule;
  grant: RateRule;
  shareLinkCreate: RateRule;
  projectCreate: RateRule;
  memberLookup: RateRule;
  comment: RateRule;
  mcpRead: RateRule;
} = {
  setup: { name: 'setup', limit: 10, windowMs: 900_000 },
  password: { name: 'password', limit: 10, windowMs: 900_000 },
  passwordGlobal: { name: 'password-global', limit: 100, windowMs: 3_600_000 },
  passkey: { name: 'passkey', limit: 30, windowMs: 900_000 },
  // The rules below are per person (keyed by user id), over REST and MCP alike. `publish` counts
  // publish sessions, inline publishes, web uploads and restores; `grant`, the preview, review
  // and raw-link grants.
  publish: { name: 'publish', limit: 60, windowMs: 600_000 },
  grant: { name: 'grant', limit: 600, windowMs: 3_600_000 },
  shareLinkCreate: { name: 'share-link-create', limit: 30, windowMs: 3_600_000 },
  projectCreate: { name: 'project-create', limit: 30, windowMs: 3_600_000 },
  /**
   * An owner's add-by-email that could show them an account they do not know, per person: refused
   * ones too. `addMember` decides which adds count (domain/members.ts).
   */
  memberLookup: { name: 'member-lookup', limit: 30, windowMs: 3_600_000 },
  /**
   * A member's comment writes, per person: new threads, replies, edits, resolves and reopens.
   * Deleting is not counted. Guests' comments have their own rules, per address and per link.
   */
  comment: { name: 'comment', limit: 60, windowMs: 600_000 },
  /** `read_file` calls over MCP, per person: every call counts, refused ones too. */
  mcpRead: { name: 'mcp-read', limit: 600, windowMs: 3_600_000 },
};

/**
 * Counts one attempt under `rule` for `key` (by default the client address) and throws
 * `rate_limited` with the seconds to wait once the rule's limit is used up.
 */
export async function enforceRateLimit(
  c: Context<AppEnv>,
  rule: RateRule,
  key?: string,
): Promise<void> {
  const { deps } = c.var;
  await countAttempt(deps, rule, key ?? clientIp(c, deps.config.trustProxy));
}

/**
 * `enforceRateLimit` without a request, for code that decides itself whether an attempt counts:
 * counts one attempt under `rule` for `subject` and throws `rate_limited` once it is used up.
 */
export async function countAttempt(
  deps: Pick<AppDeps, 'rateLimiter'>,
  rule: RateRule,
  subject: string,
): Promise<void> {
  const { allowed, retryAfterMs } = await deps.rateLimiter.consume(
    `${rule.name}:${subject}`,
    rule.limit,
    rule.windowMs,
  );
  if (!allowed) throw rateLimited(Math.ceil(retryAfterMs / 1000));
}

/**
 * `enforceRateLimit` as route middleware, so the attempt counts before the body is read or
 * validated: malformed requests use up the limit too. `key` is fixed, or read from each request
 * (a route parameter with the client address, say); by default it is the client address.
 */
export function rateLimit(
  rule: RateRule,
  key?: string | ((c: Context<AppEnv>) => string),
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceRateLimit(c, rule, typeof key === 'function' ? key(c) : key);
    await next();
  };
}

/**
 * `enforceRateLimit` as route middleware for the signed-in person: one attempt of `rule`, keyed by
 * their user id, so it follows them across sessions, tokens and addresses. Put it after
 * `requireAuth` and before anything that reads the body or looks an id up, so a refusal says
 * nothing about what the request named.
 */
export function perUser(rule: RateRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceRateLimit(c, rule, authOf(c).user.id);
    await next();
  };
}
