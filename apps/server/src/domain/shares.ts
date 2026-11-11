import type { Db } from '../auth/passkeys.ts';

/**
 * How many share links of each artifact in `artifactIds` still open: not revoked, and without an
 * expiry or expiring after `now`. Artifacts without one are left out. One query.
 */
export async function countActiveShareLinks(
  db: Db,
  artifactIds: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  if (artifactIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('share_links')
    .select((eb) => ['artifact_id', eb.fn.countAll().as('count')])
    .where('artifact_id', 'in', artifactIds)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .groupBy('artifact_id')
    .execute();
  return new Map(rows.map((row) => [row.artifact_id, Number(row.count)]));
}
