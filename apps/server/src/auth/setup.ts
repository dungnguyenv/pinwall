import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { publicUrl } from '../http/public-url.ts';
import { hashPassword } from '../lib/crypto.ts';
import { AppError, badRequest, forbidden } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../lib/ids.ts';
import { insertPasskey } from './passkeys.ts';
import { checkNewPassword, storePasswordHash } from './password.ts';
import { ownerExists } from './users.ts';
import { beginRegistration, finishRegistration } from './webauthn.ts';

/** How long a printed setup link works. */
export const SETUP_LINK_TTL_MS = 86_400_000;

/** Names the link printed last, so the next announcement can retire it. */
const CURRENT_KEY = 'setup:current';
/** One per live link, under the token's hash: the token itself is never stored. */
const linkKey = (tokenHash: string) => `setup:${tokenHash}`;

interface CurrentLink {
  hash: string;
}
interface SetupLink {
  created_at: number;
}

const setupDone = () => new AppError('setup_done', 409, t('auth.setup.done'));

/**
 * While no owner exists, mints a new one-time setup link, retires the previous one and logs the
 * link at warn level under `setup_url`. Returns the link, or null once setup is complete.
 */
export async function announceSetupLink(deps: AppDeps): Promise<string | null> {
  if (await ownerExists(deps.db.db)) return null;
  const { oneTime } = deps;
  const previous = await oneTime.peek<CurrentLink>(CURRENT_KEY);
  if (previous) await oneTime.delete(linkKey(previous.hash));

  const token = newSecret();
  const hash = hashSecret(token);
  await oneTime.put<SetupLink>(linkKey(hash), { created_at: deps.clock.now() }, SETUP_LINK_TTL_MS);
  await oneTime.put<CurrentLink>(CURRENT_KEY, { hash }, SETUP_LINK_TTL_MS);

  const url = publicUrl(deps.config, `/setup?token=${token}`);
  deps.logger.warn({ setup_url: url }, t('log.setupLink', { url }));
  return url;
}

/** Throws `setup_done` (409) once an owner exists, `forbidden` for a dead or unknown link. */
export async function checkSetupToken(deps: AppDeps, token: string): Promise<void> {
  if (await ownerExists(deps.db.db)) throw setupDone();
  const link = await deps.oneTime.peek<SetupLink>(linkKey(hashSecret(token)));
  if (link === null) throw forbidden(t('auth.setup.invalidLink'));
}

/** Starts registering the owner's first passkey, for the owner id that setup will create. */
export async function beginSetupPasskey(
  deps: AppDeps,
  token: string,
  name: string,
): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  await checkSetupToken(deps, token);
  return beginRegistration(deps, {
    purpose: 'setup',
    userId: newId('usr'),
    userName: name,
    displayName: name,
    exclude: [],
  });
}

export interface SetupInput {
  token: string;
  name: string;
  email: string | null;
  password: string | null;
  passkey: { ceremonyId: string; response: RegistrationResponseJSON; name: string | null } | null;
}

/**
 * Creates the owner account from a setup link. Every check runs before the link is used up, so
 * a rejected attempt (bad password, failed passkey) leaves it working; of two requests that
 * pass them at once, only the one that takes the link creates the owner.
 */
export async function completeSetup(deps: AppDeps, input: SetupInput): Promise<UserRow> {
  if (input.password === null && input.passkey === null) {
    throw badRequest(t('auth.setup.needCredential'));
  }
  // Refuse before the slow hash: these routes stay mounted after setup, so anyone could
  // otherwise make the server hash passwords for a link that cannot work. This only looks at the
  // link; it is used up further down.
  await checkSetupToken(deps, input.token);
  // Hashing is slow, so it happens before any transaction is open.
  const passwordHash =
    input.password === null ? null : await hashPassword(checkNewPassword(input.password));
  const passkey =
    input.passkey === null
      ? null
      : await finishRegistration(deps, {
          purpose: 'setup',
          ceremonyId: input.passkey.ceremonyId,
          response: input.passkey.response,
        });

  const key = linkKey(hashSecret(input.token));
  const link = await deps.oneTime.take<SetupLink>(key);
  if (link === null) throw setupDone(); // a concurrent request took it first

  const now = deps.clock.now();
  const user: UserRow = {
    // The passkey's user handle is the id its ceremony began for.
    id: passkey?.userId ?? newId('usr'),
    kind: 'owner',
    email: input.email,
    email_verified: 0,
    name: input.name,
    avatar_url: null,
    idp_role: null,
    role_override: null,
    oidc_issuer: null,
    oidc_subject: null,
    idp_refresh_token: null,
    idp_checked_at: null,
    disabled_at: null,
    disabled_reason: null,
    created_at: now,
    last_seen_at: now,
    share_approved: 0,
    quota_bytes: null,
    quota_artifacts: null,
  };
  try {
    await deps.db.db.transaction().execute(async (trx) => {
      await trx.insertInto('users').values(user).execute();
      if (passwordHash !== null) await storePasswordHash(trx, user.id, passwordHash, now);
      if (passkey !== null) {
        const name = input.passkey?.name ?? t('auth.passkey.defaultName');
        await insertPasskey(trx, { ...passkey, name, now });
      }
    });
  } catch (error) {
    // Nothing was stored, so the link must keep working for the time it had left.
    const left = link.created_at + SETUP_LINK_TTL_MS - deps.clock.now();
    if (left > 0) await deps.oneTime.put(key, link, left);
    throw error;
  }
  await deps.oneTime.delete(CURRENT_KEY);
  return user;
}
