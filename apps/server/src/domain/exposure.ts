import type { Db } from '../auth/passkeys.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type { UserRow } from '../db/schema.ts';
import { type AppError, forbidden } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/** What `mayExpose` reads of a person. */
type ExposureFields = Pick<UserRow, 'kind' | 'idp_role' | 'role_override' | 'share_approved'>;

/**
 * Whether `user` may expose content outside Pinwall (`PINWALL_SHARE_LINKS`): make share links,
 * have their links open, follow raw links and open pages top-level. `members`: everyone;
 * `approved`: admins (effectiveRole) and users with share_approved = 1. It says nothing about
 * access itself, which callers check as they always have.
 */
export function mayExpose(config: Config, user: ExposureFields): boolean {
  if (config.shareLinks === 'members') return true;
  return effectiveRole(user) === 'admin' || user.share_approved === 1;
}

/**
 * Whether version `versionId` may be shown outside Pinwall at all, whoever asks: with
 * `PINWALL_SHARE_LINKS=approved`, when the person who published it (`versions.created_by`) may
 * expose content (`mayExpose`), or, in `personal` mode, the owner of its project may. With
 * `members` every version is, without a query. A version that is gone, or whose publisher and
 * owner are both gone, is not.
 *
 * Exposing content needs both: the person who holds the grant, follows the raw link or made the
 * share link must `mayExpose`, and the version must be exposable. Otherwise an approved person who
 * merely opens a page an unapproved person published (as a member of their project, or in team
 * mode) would hand out a top-level URL to it. Pass the transaction when one is open.
 */
export async function isExposable(db: Db, config: Config, versionId: string): Promise<boolean> {
  if (config.shareLinks === 'members') return true;
  const personal = config.visibility === 'personal';
  // The publisher, and in personal mode the owner: at most two rows, in one query.
  const people = await db
    .selectFrom('versions')
    .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
    .innerJoin('projects', 'projects.id', 'artifacts.project_id')
    .innerJoin('users', (join) =>
      join.on((eb) =>
        eb.or([
          eb('users.id', '=', eb.ref('versions.created_by')),
          ...(personal ? [eb('users.id', '=', eb.ref('projects.owner_id'))] : []),
        ]),
      ),
    )
    .select(['users.kind', 'users.idp_role', 'users.role_override', 'users.share_approved'])
    .where('versions.id', '=', versionId)
    .execute();
  return people.some((person) => mayExpose(config, person));
}

/**
 * 403 forbidden for someone `mayExpose` refuses, details { reason: 'share_links_not_approved' },
 * message t(`spaces.exposure.${what}`). It never depends on what was asked for, so callers throw
 * it before any lookup.
 */
export function notApproved(what: 'shareLink' | 'rawLink'): AppError {
  return forbidden(t(`spaces.exposure.${what}`), { reason: 'share_links_not_approved' });
}

/**
 * 403 forbidden for a version `isExposable` refuses, asked for by someone who may expose content
 * and sees it: details { reason: 'version_not_exposable' }, message
 * t(`spaces.exposure.${what}Version`).
 */
export function notExposable(what: 'shareLink' | 'rawLink'): AppError {
  return forbidden(t(`spaces.exposure.${what}Version`), { reason: 'version_not_exposable' });
}
