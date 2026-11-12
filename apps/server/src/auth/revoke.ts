import { revokeUserGrants } from '../content/grants.ts';
import type { AppDeps } from '../deps.ts';
import { endShareLinkStreams } from '../domain/live.ts';
import { revokeShareLinksOf } from '../domain/shares.ts';
import { revokeUploadSessions } from '../publish/sessions.ts';

export interface RevokeResult {
  sessions: number;
  apiTokens: number;
  oauthGrants: number;
  contentGrants: number;
  shareLinks: number;
}

/**
 * "Revoke now": ends every credential of the user in one transaction, so none survives a
 * failure halfway. The share links the user made are revoked first, as `revokeShareLinksOf`
 * says: what they shared stops opening, with the content grants made from those links. Browser
 * sessions are deleted; API tokens and OAuth grants are marked revoked (once; one already
 * revoked keeps its time and is not counted); the OAuth tokens of every grant the user has are
 * deleted, since a revoked grant has no use for them; content grants made for the user are
 * deleted and tombstoned. Once that commits, the live streams of the revoked links end, and the
 * upload URLs the user has not used are dropped from the one-time store, which the transaction
 * does not cover. The admin "Revoke now" route calls this, and so does the access re-check when
 * the IdP drops a user.
 */
export async function revokeAllCredentials(deps: AppDeps, userId: string): Promise<RevokeResult> {
  const { db, dialect } = deps.db;
  const { linkIds, ...result } = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const linkIds = await revokeShareLinksOf(trx, dialect, userId, now);
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
      linkIds,
      sessions: Number(sessions.numDeletedRows),
      apiTokens: Number(apiTokens.numUpdatedRows),
      oauthGrants: Number(oauthGrants.numUpdatedRows),
      contentGrants,
      shareLinks: linkIds.length,
    };
  });
  for (const linkId of linkIds) endShareLinkStreams(deps, linkId);
  await revokeUploadSessions(deps, userId);
  return result;
}
