import type { Transaction } from 'kysely';
import type { Db } from '../auth/passkeys.ts';
import { revokeGrantsInProjects } from '../content/grants.ts';
import type { Database, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { lockProject } from './spaces.ts';

/** What `transferContent` moved, and what it changed on the way. */
export interface TransferResult {
  projects: number;
  artifacts: number;
  /** The source's share links on the moved artifacts, which now name the target as their maker. */
  shareLinks: number;
  /** The target's memberships in the moved projects, which owning them replaces. */
  membershipsDropped: number;
  /** The new name of the source's default project, when the target already had one. */
  renamedDefault: string | null;
  /** The source's content grants on the moved artifacts (personal mode only). */
  grantsEnded: number;
}

const NOTHING_MOVED: TransferResult = {
  projects: 0,
  artifacts: 0,
  shareLinks: 0,
  membershipsDropped: 0,
  renamedDefault: null,
  grantsEnded: 0,
};

/**
 * The user `ref` names, for an operator at the command line: a ref with '@' by email, ignoring
 * letter case, among every account (blocked, disabled and unverified ones too, so a person who
 * left can still be named, and an address two accounts use is never taken for one of them);
 * otherwise `usr_…` by id. An id never holds '@', and an email may start with `usr_`. No match
 * answers 404, several 409 with their ids (oldest first), and a ref that is neither form 400.
 */
export async function findUserByRef(db: Db, ref: string): Promise<UserRow> {
  const wanted = ref.trim();
  let matches: UserRow[];
  if (wanted.includes('@')) {
    matches = await db
      .selectFrom('users')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['email']), '=', eb.fn('lower', [eb.val(wanted)])))
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  } else if (wanted.startsWith('usr_')) {
    matches = await db.selectFrom('users').selectAll().where('id', '=', wanted).execute();
  } else {
    throw badRequest(t('transfer.badRef', { ref: wanted }));
  }
  const [only, ...others] = matches;
  if (only === undefined) throw notFound(t('transfer.noUser', { ref: wanted }));
  if (others.length > 0) {
    const ids = matches.map((user) => user.id);
    throw conflict(
      t('transfer.ambiguous', { ref: wanted, count: ids.length, ids: ids.join(', ') }),
      { user_ids: ids },
    );
  }
  return only;
}

/**
 * Moves every project `from` owns to `to`, in one transaction, in either visibility mode (spec
 * §8.2). Quotas are not checked: the operator chose to move the space.
 * - Each project is held with `lockProject`, in id order, as a membership change holds one; no
 *   artifact row is locked, so writes, deletions and membership changes take turns with it there.
 * - `from`'s default becomes "Default (from <name>)" when `to` has one already.
 * - Members stay, but `to`'s own membership in a moved project goes: they own it now.
 * - `from`'s share links on the moved artifacts name `to` as their maker, so they keep opening.
 * - In personal mode, `from`'s grants on the moved artifacts end. Their live streams end at the
 *   next heartbeat, their upload URLs are refused at commit and Recent leaves the artifacts out:
 *   each checks sight when used, in whichever process serves it.
 */
export async function transferContent(
  deps: AppDeps,
  from: UserRow,
  to: UserRow,
): Promise<TransferResult> {
  if (from.id === to.id) throw badRequest(t('transfer.same'));
  const { db, dialect } = deps.db;
  const now = deps.clock.now();
  const result = await db.transaction().execute(async (trx) => {
    const listed = (
      await trx
        .selectFrom('projects')
        .select('id')
        .where('owner_id', '=', from.id)
        .orderBy('id')
        .execute()
    ).map((project) => project.id);
    if (listed.length === 0) return { ...NOTHING_MOVED };
    for (const id of listed) await lockProject(trx, dialect, id);
    // Read again under the locks: a project deleted, or moved by another transfer, while they
    // were taken is not the source's to move.
    const projects = await trx
      .selectFrom('projects')
      .select(['id', 'is_default'])
      .where('id', 'in', listed)
      .where('owner_id', '=', from.id)
      .orderBy('id')
      .execute();
    const ids = projects.map((project) => project.id);
    if (ids.length === 0) return { ...NOTHING_MOVED };

    // Before the move: an owner has at most one default (`projects_owner_default_idx`).
    const ownDefault = projects.find((project) => project.is_default === 1);
    const renamedDefault =
      ownDefault === undefined ? null : await renameIfTaken(trx, ownDefault.id, from, to);

    const dropped = await trx
      .deleteFrom('project_members')
      .where('user_id', '=', to.id)
      .where('project_id', 'in', ids)
      .executeTakeFirst();
    const links = await trx
      .updateTable('share_links')
      .set({ created_by: to.id })
      .where('created_by', '=', from.id)
      .where('artifact_id', 'in', (eb) =>
        eb.selectFrom('artifacts').select('artifacts.id').where('artifacts.project_id', 'in', ids),
      )
      .executeTakeFirst();
    const grantsEnded =
      deps.config.visibility === 'personal'
        ? await revokeGrantsInProjects(trx, from.id, ids, now)
        : 0;
    await trx
      .updateTable('projects')
      .set({ owner_id: to.id, updated_at: now })
      .where('id', 'in', ids)
      .execute();
    const artifacts = await trx
      .selectFrom('artifacts')
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('project_id', 'in', ids)
      .executeTakeFirstOrThrow();
    return {
      projects: ids.length,
      artifacts: Number(artifacts.n),
      shareLinks: Number(links.numUpdatedRows),
      membershipsDropped: Number(dropped.numDeletedRows),
      renamedDefault,
      grantsEnded,
    };
  });
  deps.logger.info(
    {
      action: 'transfer',
      from_id: from.id,
      to_id: to.id,
      projects: result.projects,
      artifacts: result.artifacts,
      share_links: result.shareLinks,
      memberships_dropped: result.membershipsDropped,
      renamed_default: result.renamedDefault,
      grants_ended: result.grantsEnded,
    },
    'transfer',
  );
  return result;
}

/**
 * When `to` owns a default project, makes `from`'s default `projectId` an ordinary project named
 * after `from`, and returns that name; otherwise leaves it as it is (`to` takes it as their
 * default) and returns null.
 */
async function renameIfTaken(
  trx: Transaction<Database>,
  projectId: string,
  from: UserRow,
  to: UserRow,
): Promise<string | null> {
  const taken = await trx
    .selectFrom('projects')
    .select('id')
    .where('owner_id', '=', to.id)
    .where('is_default', '=', 1)
    .executeTakeFirst();
  if (taken === undefined) return null;
  const name = t('transfer.defaultName', { name: from.name ?? from.email ?? from.id });
  await trx
    .updateTable('projects')
    .set({ name, is_default: 0 })
    .where('id', '=', projectId)
    .execute();
  return name;
}
