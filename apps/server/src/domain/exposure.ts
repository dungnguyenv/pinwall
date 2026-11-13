import { effectiveRole } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type { UserRow } from '../db/schema.ts';
import { type AppError, forbidden } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/**
 * Whether `user` may expose content outside Pinwall (`PINWALL_SHARE_LINKS`): make share links,
 * have their links open, follow raw links and open pages top-level. `members`: everyone;
 * `approved`: admins (effectiveRole) and users with share_approved = 1. It says nothing about
 * access itself, which callers check as they always have.
 */
export function mayExpose(config: Config, user: UserRow): boolean {
  if (config.shareLinks === 'members') return true;
  return effectiveRole(user) === 'admin' || user.share_approved === 1;
}

/**
 * 403 forbidden for someone `mayExpose` refuses, details { reason: 'share_links_not_approved' },
 * message t(`spaces.exposure.${what}`). It never depends on what was asked for, so callers throw
 * it before any lookup.
 */
export function notApproved(what: 'shareLink' | 'rawLink'): AppError {
  return forbidden(t(`spaces.exposure.${what}`), { reason: 'share_links_not_approved' });
}
