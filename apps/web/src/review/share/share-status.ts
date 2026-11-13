import type { Me, ShareLink } from '../../api/dto.ts';
import { formatRelativeTime } from '../../lib/format.ts';

const DAY = 86_400_000;
/** A link with less than this left is flagged. */
const SOON = 6 * 3_600_000;

/** How long a new link lasts, in days; `null` is until it is revoked. */
export const EXPIRY_DAYS = [null, 1, 7, 30] as const;
export type ExpiryDays = (typeof EXPIRY_DAYS)[number];

/** The moment a link made at `now` that lasts `days` days ends; `null` for one that does not. */
export function expiresAtFor(days: number | null, now: number): number | null {
  return days === null ? null : now + days * DAY;
}

export interface ShareStatus {
  tone: 'neutral' | 'warning' | 'danger';
  /** An i18n key, spelled out here so it can be found by search. */
  key: string;
  vars?: Record<string, unknown>;
}

/**
 * Where a link stands: revoked or expired (danger), within its last
 * hours (warning), or fine. The server's `status` counts, and so does the clock,
 * since a list read a while ago may show a link that has expired since.
 */
export function shareStatus(l: ShareLink, now: number): ShareStatus {
  if (l.status === 'revoked' || l.revoked_at !== null) {
    return { tone: 'danger', key: 'web.share.status.revoked' };
  }
  if (l.status === 'expired' || (l.expires_at !== null && l.expires_at <= now)) {
    return { tone: 'danger', key: 'web.share.status.expired' };
  }
  if (l.expires_at === null) return { tone: 'neutral', key: 'web.share.status.never' };
  return {
    tone: l.expires_at - now < SOON ? 'warning' : 'neutral',
    key: 'web.share.status.expires',
    vars: { when: formatRelativeTime(l.expires_at, now) },
  };
}

/** Whether `me` may revoke `l`, as the server decides: its creator, the artifact's publisher, or an admin. */
export function canRevoke(
  me: Me,
  artifact: { created_by: string | null },
  l: Pick<ShareLink, 'created_by'>,
): boolean {
  return me.role === 'admin' || artifact.created_by === me.id || l.created_by?.user_id === me.id;
}
