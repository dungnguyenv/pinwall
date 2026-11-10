import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { clientIp } from '../http/client-ip.ts';
import { rateLimited } from '../lib/errors.ts';

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
} = {
  setup: { name: 'setup', limit: 10, windowMs: 900_000 },
  password: { name: 'password', limit: 10, windowMs: 900_000 },
  passwordGlobal: { name: 'password-global', limit: 100, windowMs: 3_600_000 },
  passkey: { name: 'passkey', limit: 30, windowMs: 900_000 },
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
  const { config, rateLimiter } = c.var.deps;
  const subject = key ?? clientIp(c, config.trustProxy);
  const { allowed, retryAfterMs } = await rateLimiter.consume(
    `${rule.name}:${subject}`,
    rule.limit,
    rule.windowMs,
  );
  if (!allowed) throw rateLimited(Math.ceil(retryAfterMs / 1000));
}
