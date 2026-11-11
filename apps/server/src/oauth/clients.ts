import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import type { OAuthClientRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';
import { MAX_CLIENT_NAME, MAX_REDIRECT_URIS, OAUTH_SCOPE } from './constants.ts';
import { OAuthError } from './errors.ts';
import { checkRedirectUri } from './redirect-uris.ts';

/** The RFC 7591 registration response: what Pinwall registered, whatever the client asked for. */
export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
  scope: 'pinwall';
}

/**
 * The client metadata Pinwall reads (RFC 7591 §2). Other fields are allowed and ignored;
 * `client_uri` and `scope` are accepted but not stored, since every client gets the one scope.
 */
const ClientMetadata = z.looseObject({
  redirect_uris: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  scope: z.string().optional(),
});
type ClientMetadata = z.infer<typeof ClientMetadata>;

const GRANT_TYPES: readonly string[] = ['authorization_code', 'refresh_token'];

/** A redirect URI quoted in an error message is cut to this many characters. */
const QUOTED_URI_MAX = 100;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** `uri` for an error message: controls made visible as percent escapes, then cut with `…`. */
function quoteUri(uri: string): string {
  const chars = Array.from(uri.replace(CONTROL_OR_FORMAT, (ch) => encodeURIComponent(ch)));
  if (chars.length <= QUOTED_URI_MAX) return chars.join('');
  return `${chars.slice(0, QUOTED_URI_MAX - 1).join('')}…`;
}

/**
 * A client name as the consent page shows it: control and format characters (bidi overrides,
 * zero-width characters) removed, whitespace collapsed to single spaces, trimmed and cut to
 * `MAX_CLIENT_NAME` code points. Nothing left gives "Unnamed app". The name is still whatever
 * the client claims, never proof of who it is.
 */
export function cleanClientName(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .replace(CONTROL_OR_FORMAT, (ch) => (/\s/.test(ch) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_CLIENT_NAME).join('').trimEnd();
  return name === '' ? t('oauth.client.unnamed') : name;
}

function parseMetadata(body: unknown): ClientMetadata {
  const parsed = ClientMetadata.safeParse(body);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  if (typeof field !== 'string') {
    throw new OAuthError('invalid_client_metadata', t('oauth.register.body'));
  }
  const code = field === 'redirect_uris' ? 'invalid_redirect_uri' : 'invalid_client_metadata';
  throw new OAuthError(code, t('oauth.register.fieldType', { field }));
}

/** The redirect URIs to register; throws `invalid_redirect_uri` naming the first bad one. */
function validRedirectUris(uris: string[] | undefined): string[] {
  if (!uris || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', t('oauth.register.redirectCount'));
  }
  for (const uri of uris) {
    const check = checkRedirectUri(uri);
    if (!check.ok) {
      const message = t(`oauth.register.redirect.${check.problem}`, { uri: quoteUri(uri) });
      throw new OAuthError('invalid_redirect_uri', message);
    }
  }
  return uris;
}

/**
 * RFC 7591 dynamic registration of a public client: no secret, PKCE at the token endpoint.
 * Refuses confidential clients, grant types other than `authorization_code` (with an optional
 * `refresh_token`), response types other than `code`, and any redirect URI `checkRedirectUri`
 * refuses. Every client is registered for both grant types and the `pinwall` scope.
 */
export async function registerClient(deps: AppDeps, body: unknown): Promise<RegisteredClient> {
  const metadata = parseMetadata(body);
  if ((metadata.token_endpoint_auth_method ?? 'none') !== 'none') {
    throw new OAuthError('invalid_client_metadata', t('oauth.register.publicOnly'));
  }
  // RFC 7591 §2.1: the `code` response type goes with the `authorization_code` grant.
  const grants = metadata.grant_types ?? ['authorization_code'];
  if (!grants.includes('authorization_code') || !grants.every((g) => GRANT_TYPES.includes(g))) {
    throw new OAuthError('invalid_client_metadata', t('oauth.register.grantTypes'));
  }
  const responses = metadata.response_types ?? ['code'];
  if (!responses.includes('code') || !responses.every((r) => r === 'code')) {
    throw new OAuthError('invalid_client_metadata', t('oauth.register.responseTypes'));
  }
  const redirectUris = validRedirectUris(metadata.redirect_uris);

  const id = newId('cli');
  const name = cleanClientName(metadata.client_name);
  const now = deps.clock.now();
  await deps.db.db
    .insertInto('oauth_clients')
    .values({
      id,
      name,
      redirect_uris: JSON.stringify(redirectUris),
      created_at: now,
      last_used_at: null,
    })
    .execute();
  deps.logger.info({ client_id: id }, 'oauth client registered');

  return {
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: OAUTH_SCOPE,
  };
}

export function getClient(db: Db, id: string): Promise<OAuthClientRow | undefined> {
  return db.selectFrom('oauth_clients').selectAll().where('id', '=', id).executeTakeFirst();
}

/** The redirect URIs a client registered; a row that does not hold a list of strings has none. */
export function clientRedirectUris(row: OAuthClientRow): string[] {
  let uris: unknown;
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {
    return [];
  }
  return Array.isArray(uris) && uris.every((uri) => typeof uri === 'string') ? uris : [];
}

/** Records that the client was just used, which keeps the idle cleanup from deleting it. */
export async function touchClient(deps: AppDeps, id: string): Promise<void> {
  await deps.db.db
    .updateTable('oauth_clients')
    .set({ last_used_at: deps.clock.now() })
    .where('id', '=', id)
    .execute();
}
