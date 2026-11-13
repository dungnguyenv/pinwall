import type { Db } from '../auth/passkeys.ts';
import { type Config, ConfigError } from '../config/types.ts';
import { backfillProjectOwners } from '../db/migrations/0003_spaces.ts';
import type { AppDeps } from '../deps.ts';
import { t } from '../lib/i18n.ts';
import { ensureDefaultProject } from './projects.ts';

/** The `instance_settings` key that records the visibility mode Pinwall last ran in. */
export const LAST_VISIBILITY = 'visibility.last';

export async function readSetting(db: Db, key: string): Promise<string | null> {
  const row = await db
    .selectFrom('instance_settings')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.value ?? null;
}

/** Sets `key` to `value`, replacing what it held. */
export async function writeSetting(db: Db, key: string, value: string, now: number): Promise<void> {
  await db
    .insertInto('instance_settings')
    .values({ key, value, updated_at: now })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
    .execute();
}

/** How many different people own a project. Projects nobody owns count for no one. */
export async function countProjectOwners(db: Db): Promise<number> {
  const row = await db
    .selectFrom('projects')
    .select((eb) => eb.fn.count('owner_id').distinct().as('owners'))
    .executeTakeFirstOrThrow();
  // PostgreSQL returns a count as a string.
  return Number(row.owners);
}

/**
 * Refuses to start in `team` mode after `personal` while more than one person owns a project:
 * every member would see all of their projects. `pinwall visibility team --confirm` allows it
 * once. In every other case it records the mode the server runs in now.
 */
export async function checkVisibility(deps: AppDeps): Promise<void> {
  const { db } = deps.db;
  const { visibility } = deps.config;
  const last = await readSetting(db, LAST_VISIBILITY);
  if (visibility === 'team' && last === 'personal') {
    const owners = await countProjectOwners(db);
    if (owners > 1) throw new ConfigError([t('spaces.guard.refused', { owners })]);
  }
  if (last !== visibility) await writeSetting(db, LAST_VISIBILITY, visibility, deps.clock.now());
}

/** Records that `team` mode may start next, and returns how many people own projects. */
export async function confirmTeamVisibility(db: Db, now: number): Promise<number> {
  const owners = await countProjectOwners(db);
  await writeSetting(db, LAST_VISIBILITY, 'team', now);
  return owners;
}

/**
 * The warning for a `team` instance whose identity provider is on but which has no member rule:
 * everyone it signs in is a member, and members see every project. Null when there is no reason
 * to warn. It is not part of `config.warnings`; `startSpaces` logs it.
 */
export function openAdmissionWarning(config: Config): string | null {
  const { oidc, access } = config;
  const openAdmission =
    oidc !== null &&
    oidc.memberGroups.length === 0 &&
    access.memberEmails.length === 0 &&
    access.memberDomains.length === 0;
  if (config.visibility !== 'team' || !openAdmission) return null;
  return (
    'PINWALL_VISIBILITY is team and no member rule is set (PINWALL_OIDC_MEMBER_GROUPS, ' +
    'PINWALL_MEMBER_EMAILS or PINWALL_MEMBER_DOMAINS): anyone the identity provider signs in ' +
    'becomes a member and sees every project. Set a member rule, or PINWALL_VISIBILITY=personal.'
  );
}

/**
 * What `serve` does about spaces before it listens: checks the mode against the last one
 * (`checkVisibility`), makes sure the default project exists and gives every project without an
 * owner one, then logs the open-admission warning.
 */
export async function startSpaces(deps: AppDeps): Promise<void> {
  await checkVisibility(deps);
  await ensureDefaultProject(deps);
  await backfillProjectOwners(deps.db.db);
  const warning = openAdmissionWarning(deps.config);
  if (warning !== null) deps.logger.warn(warning);
}
