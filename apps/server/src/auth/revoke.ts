import { revokeUserGrants } from '../content/grants.ts';
import type { AppDeps } from '../deps.ts';
import { revokeUploadSessions } from '../publish/sessions.ts';

export interface RevokeResult {
  sessions: number;
  apiTokens: number;
  oauthGrants: number;
  contentGrants: number;
}

/**
 * "Revoke now": ends every credential of the user in one transaction, so none survives a
 * failure halfway. Browser sessions are deleted; API tokens and OAuth grants are marked revoked
 * (once; one already revoked keeps its time and is not counted); the OAuth tokens of every
 * grant the user has are deleted, since a revoked grant has no use for them; content grants made
 * for the user are deleted and tombstoned. Once that commits, the upload URLs the user has not
 * used are dropped from the one-time store, which the transaction does not cover. The admin
 * "Revoke now" route calls this, and so does the access re-check when the IdP drops a user.
 */
export async function revokeAllCredentials(deps: AppDeps, userId: string): Promise<RevokeResult> {
  const result = await deps.db.db.transaction().execute(async (trx) => {
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
    const contentGrants = await revokeUserGrants(trx, userId, now);
    return {
      sessions: Number(sessions.numDeletedRows),
      apiTokens: Number(apiTokens.numUpdatedRows),
      oauthGrants: Number(oauthGrants.numUpdatedRows),
      contentGrants,
    };
  });
  await revokeUploadSessions(deps, userId);
  return result;
}
