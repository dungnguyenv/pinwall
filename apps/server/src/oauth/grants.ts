import type { OAuthGrantRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { newId } from '../lib/ids.ts';

/**
 * The grant a person's approval stands for: the newest unrevoked grant of the same client, user
 * and resource, so approving again does not pile up grants, or else a new one. A revoked grant
 * is never brought back.
 */
export async function findOrCreateGrant(
  deps: AppDeps,
  p: { clientId: string; userId: string; resource: string; scope: string },
): Promise<OAuthGrantRow> {
  const { db } = deps.db;
  const existing = await db
    .selectFrom('oauth_grants')
    .selectAll()
    .where('client_id', '=', p.clientId)
    .where('user_id', '=', p.userId)
    .where('resource', '=', p.resource)
    .where('revoked_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (existing) return existing;

  const grant: OAuthGrantRow = {
    id: newId('gnt'),
    client_id: p.clientId,
    user_id: p.userId,
    resource: p.resource,
    scope: p.scope,
    created_at: deps.clock.now(),
    last_used_at: null,
    revoked_at: null,
  };
  await db.insertInto('oauth_grants').values(grant).execute();
  return grant;
}

/**
 * Ends a grant in one transaction: marks it revoked (once; a grant already revoked keeps its
 * time) and deletes its access and refresh tokens.
 */
export async function revokeGrant(deps: AppDeps, grantId: string): Promise<void> {
  await deps.db.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('oauth_grants')
      .set({ revoked_at: deps.clock.now() })
      .where('id', '=', grantId)
      .where('revoked_at', 'is', null)
      .execute();
    await trx.deleteFrom('oauth_tokens').where('grant_id', '=', grantId).execute();
  });
}
