import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { checkPassword } from './password.ts';
import { hasAccess } from './roles.ts';
import { getOwner, ownerExists } from './users.ts';
import { beginAuthentication, finishAuthentication } from './webauthn.ts';

const setupRequired = () => new AppError('setup_required', 409, t('auth.setup.required'));
const accessDenied = () => new AppError('access_denied', 403, t('auth.accessDenied'));

/** Access is checked only once the credential is verified: a wrong guess learns nothing more. */
function admit(owner: UserRow): UserRow {
  if (!hasAccess(owner)) throw accessDenied();
  return owner;
}

/**
 * The owner, when `password` (in any Unicode form) is theirs. Starting the session is the
 * caller's job.
 */
export async function signInWithPassword(deps: AppDeps, password: string): Promise<UserRow> {
  const owner = await getOwner(deps.db.db);
  if (!owner) throw setupRequired();
  if (!(await checkPassword(deps.db.db, owner.id, password))) {
    throw new AppError('invalid_credentials', 401, t('auth.wrongPassword'));
  }
  return admit(owner);
}

/** Starts a sign-in with any passkey the owner holds (discoverable, no allow list). */
export async function beginPasskeySignIn(
  deps: AppDeps,
): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  if (!(await ownerExists(deps.db.db))) throw setupRequired();
  return beginAuthentication(deps);
}

/** The owner, when the assertion verifies against one of the owner's passkeys. */
export async function signInWithPasskey(
  deps: AppDeps,
  ceremonyId: string,
  response: AuthenticationResponseJSON,
): Promise<UserRow> {
  const { passkey } = await finishAuthentication(deps, { ceremonyId, response });
  const owner = await getOwner(deps.db.db);
  // Only the owner registers passkeys; anyone else's is not a way into the owner account.
  if (owner?.id !== passkey.user_id) {
    deps.logger.info(
      { passkey_id: passkey.id },
      'A passkey of a user other than the owner was used',
    );
    throw new AppError('invalid_credentials', 401, t('auth.passkeyFailed'));
  }
  return admit(owner);
}
