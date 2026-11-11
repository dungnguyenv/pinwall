import type { Context } from 'hono';
import type { Transaction } from 'kysely';
import type { AppEnv, AuthContext } from '../app.ts';
import type { BearerResolver } from '../auth/resolve.ts';
import { hasAccess } from '../auth/roles.ts';
import type { Database } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newSecret } from '../lib/ids.ts';
import { mediaType, readBody } from './body.ts';
import { getClient, touchClient } from './clients.ts';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  GRANT_TOUCH_INTERVAL_MS,
  OAUTH_SCOPE,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  USED_CODE_TTL_MS,
} from './constants.ts';
import { OAuthError } from './errors.ts';
import { revokeGrant } from './grants.ts';
import { mcpResourceUrl, normalizeResource } from './metadata.ts';
import { verifyPkce } from './pkce.ts';
import { type AuthorizationCode, codeKey } from './requests.ts';

/** A successful token response (RFC 6749 §5.1): a bearer access token and its refresh token. */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  /** `ACCESS_TOKEN_TTL_MS` in seconds. */
  expires_in: 3600;
  refresh_token: string;
  scope: 'pinwall';
}

/** The largest token or revocation request body read. */
const MAX_FORM_BYTES = 16_384;

/** What a redeemed code leaves behind, so a replay of it can end the grant it was for. */
interface UsedCode {
  grantId: string;
}

const usedCodeKey = (code: string) => `oauth:code-used:${hashSecret(code)}`;

/**
 * The form a token or revocation request carries: `application/x-www-form-urlencoded` (any
 * parameters on the media type, such as a charset, allowed), at most `MAX_FORM_BYTES`, with no
 * parameter sent twice (RFC 6749 §3.2). Anything else is `invalid_request`.
 */
export async function readTokenForm(c: Context<AppEnv>): Promise<URLSearchParams> {
  if (mediaType(c.req.header('content-type')) !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', t('oauth.token.form'));
  }
  const text = await readBody(
    c,
    MAX_FORM_BYTES,
    () => new OAuthError('invalid_request', t('oauth.body.tooLarge')),
  );
  const form = new URLSearchParams(text);
  const names = new Set(form.keys());
  if (names.size !== [...form.keys()].length) {
    throw new OAuthError('invalid_request', t('oauth.token.repeated'));
  }
  return form;
}

/**
 * Issues a new access and refresh token for `grantId`, inside the caller's transaction. Only
 * their hashes are stored; the tokens themselves are in the response and nowhere else.
 */
export async function issueTokens(
  trx: Transaction<Database>,
  grantId: string,
  now: number,
): Promise<TokenResponse> {
  const access = `${ACCESS_TOKEN_PREFIX}${newSecret()}`;
  const refresh = `${REFRESH_TOKEN_PREFIX}${newSecret()}`;
  await trx
    .insertInto('oauth_tokens')
    .values([
      {
        token_hash: hashSecret(access),
        grant_id: grantId,
        kind: 'access',
        created_at: now,
        expires_at: now + ACCESS_TOKEN_TTL_MS,
        used_at: null,
      },
      {
        token_hash: hashSecret(refresh),
        grant_id: grantId,
        kind: 'refresh',
        created_at: now,
        expires_at: now + REFRESH_TOKEN_TTL_MS,
        used_at: null,
      },
    ])
    .execute();
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope: OAUTH_SCOPE,
  };
}

const accessEnded = () => new OAuthError('invalid_grant', t('oauth.token.accessEnded'));

/**
 * Redeems an authorization code (RFC 6749 §4.1.3, PKCE per RFC 7636 §4.6, `resource` per
 * RFC 8707 §2.2). The client must exist (else `invalid_client`, which makes an MCP client
 * register again), and the code is then used up whatever follows: a mismatched client,
 * `redirect_uri` or `code_verifier` gets `invalid_grant`, another resource `invalid_target`, a
 * revoked grant or a user without access `invalid_grant`. A code presented again within
 * `USED_CODE_TTL_MS` is taken for a stolen one: the grant it was for is revoked, with every token
 * it holds (RFC 6749 §4.1.2).
 */
export async function exchangeCode(deps: AppDeps, form: URLSearchParams): Promise<TokenResponse> {
  const clientId = form.get('client_id');
  const client = clientId === null ? undefined : await getClient(deps.db.db, clientId);
  if (!client) throw new OAuthError('invalid_client', t('oauth.token.unknownClient'));

  const raw = form.get('code') ?? '';
  const code = raw === '' ? null : await deps.oneTime.take<AuthorizationCode>(codeKey(raw));
  if (!code) {
    const used = raw === '' ? null : await deps.oneTime.peek<UsedCode>(usedCodeKey(raw));
    if (used) {
      await revokeGrant(deps, used.grantId);
      deps.logger.warn(
        { client_id: client.id, grant_id: used.grantId },
        'oauth code replayed; grant revoked',
      );
    }
    throw new OAuthError('invalid_grant', t('oauth.token.badCode'));
  }
  await deps.oneTime.put<UsedCode>(usedCodeKey(raw), { grantId: code.grantId }, USED_CODE_TTL_MS);

  if (
    code.clientId !== client.id ||
    code.redirectUri !== form.get('redirect_uri') ||
    !verifyPkce(form.get('code_verifier') ?? '', code.codeChallenge)
  ) {
    throw new OAuthError('invalid_grant', t('oauth.token.mismatch'));
  }
  const resource = form.get('resource');
  if (resource !== null && normalizeResource(resource) !== code.resource) {
    throw new OAuthError('invalid_target', t('oauth.token.resource', { resource: code.resource }));
  }

  const { db } = deps.db;
  const grant = await db
    .selectFrom('oauth_grants')
    .selectAll()
    .where('id', '=', code.grantId)
    .executeTakeFirst();
  const user = grant
    ? await db.selectFrom('users').selectAll().where('id', '=', grant.user_id).executeTakeFirst()
    : undefined;
  if (!grant || grant.revoked_at !== null || !user || !hasAccess(user)) throw accessEnded();

  const now = deps.clock.now();
  const tokens = await db.transaction().execute(async (trx) => {
    // Revoked since it was read: no tokens. Updated first, so a revocation running alongside
    // waits for this to commit and then deletes what it issued.
    const touched = await trx
      .updateTable('oauth_grants')
      .set({ last_used_at: now })
      .where('id', '=', grant.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (touched.numUpdatedRows === 0n) throw accessEnded();
    return issueTokens(trx, grant.id, now);
  });
  await touchClient(deps, client.id);
  deps.logger.info(
    { client_id: client.id, grant_id: grant.id, user_id: user.id },
    'oauth tokens issued',
  );
  return tokens;
}

/**
 * Bearer tokens that start with `pwa_`: OAuth access tokens, for `/mcp` only, so this resolver is
 * never in `bearerResolvers`. A token resolves while it is unexpired and its grant is unrevoked
 * and for the MCP resource at today's public origin. Whether the user may use Pinwall is the
 * caller's check (`resolveAuth`). The grant's `last_used_at`, and the user's `last_seen_at`, are
 * written at most once per `GRANT_TOUCH_INTERVAL_MS`.
 */
export const oauthAccessTokenResolver: BearerResolver = {
  name: 'oauth',
  matches: (token) => token.startsWith(ACCESS_TOKEN_PREFIX),
  async resolve(deps, token): Promise<AuthContext | null> {
    const { db } = deps.db;
    const now = deps.clock.now();
    const found = await db
      .selectFrom('oauth_tokens')
      .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
      .select(['oauth_grants.id as grantId', 'oauth_grants.user_id', 'oauth_grants.last_used_at'])
      .where('oauth_tokens.token_hash', '=', hashSecret(token))
      .where('oauth_tokens.kind', '=', 'access')
      .where('oauth_tokens.expires_at', '>', now)
      .where('oauth_grants.revoked_at', 'is', null)
      .where('oauth_grants.resource', '=', mcpResourceUrl(deps.config))
      .executeTakeFirst();
    if (!found) return null;
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', found.user_id)
      .executeTakeFirst();
    if (!user) return null;

    if (found.last_used_at === null || now - found.last_used_at >= GRANT_TOUCH_INTERVAL_MS) {
      const touched = await db
        .updateTable('oauth_grants')
        .set({ last_used_at: now })
        .where('id', '=', found.grantId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      // Revoked by a request that ran in between: do not let this one through.
      if (touched.numUpdatedRows === 0n) return null;
      await db.updateTable('users').set({ last_seen_at: now }).where('id', '=', user.id).execute();
      return { user: { ...user, last_seen_at: now }, via: 'oauth' };
    }
    return { user, via: 'oauth' };
  },
};
