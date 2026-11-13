import type { Updateable } from 'kysely';
import type { ArtifactRow, ArtifactsTable } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { getArtifact, getTags, lockArtifact, normalizeTags } from './artifacts.ts';
import { reindexArtifact } from './search.ts';
import { assertCan, roleIn, type Scope, seesAll, whereVisible } from './spaces.ts';

/**
 * Renames an artifact, moves it to another project, or replaces its tags; only what is given,
 * all in one transaction, so a refused part (an unknown or archived project, a bad tag) leaves
 * the rest unapplied. A change counts as an update: `updated_at` moves, unless nothing differs
 * from what is stored. A rename or new tags then reach the search index.
 *
 * The artifact and the target project must be ones `scope` sees (else 404, as for missing ones).
 * The target project must not be archived (409); on Postgres its row stays share-locked until
 * the commit, so archiving it waits for a move that has already checked it. In personal mode the
 * viewer's role must allow changing the artifact, a move stays between projects of one owner,
 * and the viewer must be able to publish into the target (403 otherwise).
 */
export async function updateArtifact(
  deps: AppDeps,
  scope: Scope,
  id: string,
  p: { name?: string; projectId?: string; tags?: readonly string[] },
): Promise<ArtifactRow> {
  const { db, dialect } = deps.db;
  const tags = p.tags === undefined ? undefined : normalizeTags(p.tags);

  const { artifact, reindex } = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const current =
      (await lockArtifact(trx, dialect, scope, id)) ?? (await getArtifact(trx, scope, id, now));
    assertCan(scope, await roleIn(trx, scope, current.project_id), 'editArtifact', {
      publishedBy: current.created_by,
      userId: scope.kind === 'viewer' ? scope.user.id : undefined,
    });
    const patch: Updateable<ArtifactsTable> = {};

    if (p.name !== undefined && p.name !== current.name) patch.name = p.name;

    if (p.projectId !== undefined && p.projectId !== current.project_id) {
      const project = await whereVisible(
        trx
          .selectFrom('projects')
          .select(['id', 'archived_at', 'owner_id'])
          .where('id', '=', p.projectId),
        scope,
        'projects.id',
      )
        .$if(dialect === 'postgres', (qb) => qb.forShare())
        .executeTakeFirst();
      if (project === undefined) throw notFound(t('project.notFound'));
      if (!seesAll(scope)) {
        const source = await trx
          .selectFrom('projects')
          .select('owner_id')
          .where('id', '=', current.project_id)
          .executeTakeFirstOrThrow();
        if (project.owner_id !== source.owner_id) {
          throw forbidden(t('spaces.move.otherSpace'), { reason: 'other_space' });
        }
        assertCan(scope, await roleIn(trx, scope, project.id), 'publish');
      }
      if (project.archived_at !== null) throw conflict(t('project.archived'));
      patch.project_id = project.id;
    }

    let tagsChanged = false;
    if (tags !== undefined) {
      const before = await getTags(trx, id);
      tagsChanged = before.length !== tags.length || before.some((tag, i) => tag !== tags[i]);
      if (tagsChanged) {
        await trx.deleteFrom('artifact_tags').where('artifact_id', '=', id).execute();
        if (tags.length > 0) {
          await trx
            .insertInto('artifact_tags')
            .values(tags.map((tag) => ({ artifact_id: id, tag })))
            .execute();
        }
      }
    }

    if (Object.keys(patch).length === 0 && !tagsChanged) {
      return { artifact: current, reindex: false };
    }
    const change = { ...patch, updated_at: now };
    await trx.updateTable('artifacts').set(change).where('id', '=', id).execute();
    return {
      artifact: { ...current, ...change },
      reindex: patch.name !== undefined || tagsChanged,
    };
  });

  if (reindex) await reindexArtifact(deps, id);
  return artifact;
}
