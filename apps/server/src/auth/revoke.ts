import type { AppDeps } from '../deps.ts';

export interface RevokeResult {
  sessions: number;
  apiTokens: number;
  oauthGrants: number;
}

/**
 * "Revoke now": ends every credential of the user in one transaction, so none survives a
 * failure halfway. Browser sessions are deleted; API tokens and OAuth grants are marked revoked
 * (once; one already revoked keeps its time and is not counted); the OAuth tokens of every
 * grant the user has are deleted, since a revoked grant has no use for them. The admin
 * "Revoke now" route calls this, and so will the access re-check that M3 adds.
 */
export function revokeAllCredentials(deps: AppDeps, userId: string): Promise<RevokeResult> {
  return deps.db.db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const sessions = await trx
      .deleteFrom('sessions')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const apiTokens = await trx
      .updateTable('api_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const oauthGrants = await trx
      .updateTable('oauth_grants')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    await trx
      .deleteFrom('oauth_tokens')
      .where(
        'grant_id',
        'in',
        trx.selectFrom('oauth_grants').select('id').where('user_id', '=', userId),
      )
      .execute();
    return {
      sessions: Number(sessions.numDeletedRows),
      apiTokens: Number(apiTokens.numUpdatedRows),
      oauthGrants: Number(oauthGrants.numUpdatedRows),
    };
  });
}
