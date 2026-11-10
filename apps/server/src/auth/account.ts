import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Transaction } from 'kysely';
import type { AuthContext } from '../app.ts';
import type { DbDialect } from '../db/connect.ts';
import type { Database, PasskeyRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { hashPassword } from '../lib/crypto.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { type Db, findPasskeyByCredentialId, insertPasskey, listPasskeys } from './passkeys.ts';
import { checkNewPassword, checkPassword, storePasswordHash } from './password.ts';
import { deleteUserSessions } from './sessions.ts';
import { beginRegistration, finishRegistration } from './webauthn.ts';

const passkeyNotFound = () => notFound(t('auth.passkeyNotFound'));
const lastCredential = () => conflict(t('auth.lastCredential'));
const passkeyDuplicate = () => conflict(t('auth.passkeyDuplicate'));

/**
 * Takes a row lock on the user for the rest of the transaction, so two requests that each count
 * the user's credentials before removing one take turns instead of both passing the count. A
 * SQLite database has a single writer, so transactions already take turns there.
 */
export async function lockUser(
  trx: Transaction<Database>,
  dialect: DbDialect,
  userId: string,
): Promise<void> {
  if (dialect !== 'postgres') return;
  await trx.selectFrom('users').select('id').where('id', '=', userId).forUpdate().execute();
}

/** Changes what the user has set about themselves; a field left `undefined` stays as it is. */
export async function updateProfile(
  deps: AppDeps,
  userId: string,
  p: { name?: string; email?: string | null },
): Promise<UserRow> {
  const { db } = deps.db;
  const changes: { name?: string; email?: string | null } = {};
  if (p.name !== undefined) changes.name = p.name;
  if (p.email !== undefined) changes.email = p.email;
  if (Object.keys(changes).length > 0) {
    await db.updateTable('users').set(changes).where('id', '=', userId).execute();
  }
  return db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
}

/** What the user can sign in with right now. */
async function credentialsOf(
  db: Db,
  userId: string,
): Promise<{ password: boolean; passkeys: number }> {
  const password = await db
    .selectFrom('password_credentials')
    .select('user_id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const passkeys = await db
    .selectFrom('passkeys')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return { password: password !== undefined, passkeys: Number(passkeys.n) };
}

/**
 * Sets the owner's password, replacing the one they have. With a password already set, `current`
 * must be it: a stolen session alone cannot lock the owner out. Without one (a passkey-only
 * owner adding their first), there is nothing to check. Every session but the caller's ends.
 */
export async function changePassword(
  deps: AppDeps,
  auth: AuthContext,
  p: { current: string | null; next: string },
): Promise<void> {
  const { db } = deps.db;
  const userId = auth.user.id;
  const next = checkNewPassword(p.next);
  const { password } = await credentialsOf(db, userId);
  if (password && (p.current === null || !(await checkPassword(db, userId, p.current)))) {
    throw new AppError('invalid_credentials', 401, t('auth.wrongPassword'));
  }
  // Hashing is slow, so it happens before the write.
  const hash = await hashPassword(next);
  await storePasswordHash(db, userId, hash, deps.clock.now());
  await deleteUserSessions(
    deps,
    userId,
    auth.sessionId === undefined ? {} : { exceptIdHash: auth.sessionId },
  );
}

/** Removes the password unless it is the user's last way to sign in. */
export async function removePassword(deps: AppDeps, userId: string): Promise<void> {
  await deps.db.db.transaction().execute(async (trx) => {
    await lockUser(trx, deps.db.dialect, userId);
    // Without the password, the passkeys are all that is left.
    if ((await credentialsOf(trx, userId)).passkeys < 1) throw lastCredential();
    await trx.deleteFrom('password_credentials').where('user_id', '=', userId).execute();
  });
}

/** The transports a passkey reported, from the JSON text the row keeps them in. */
export function passkeyTransports(row: Pick<PasskeyRow, 'transports'>): string[] {
  try {
    const parsed: unknown = JSON.parse(row.transports);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Starts adding a passkey for `user`. The passkeys they have are excluded, so an authenticator
 * that already holds one cannot register it twice; the user handle is the user's id, as for the
 * passkey made at setup.
 */
export async function beginAddPasskey(
  deps: AppDeps,
  user: UserRow,
): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const label = user.name ?? user.email ?? user.id;
  const existing = await listPasskeys(deps.db.db, user.id);
  return beginRegistration(deps, {
    purpose: 'add',
    userId: user.id,
    userName: label,
    displayName: label,
    exclude: existing.map((row) => ({
      credentialId: row.credential_id,
      transports: passkeyTransports(row),
    })),
  });
}

/** True when `error` is a database refusing a duplicate value in a unique column. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // PostgreSQL's unique_violation, and SQLite's two codes for a repeated unique or primary key.
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}

/**
 * Finishes the ceremony `beginAddPasskey` started and stores the passkey, named `name` or
 * "Passkey <n + 1>" when the user has n. A credential someone has registered already is a
 * `conflict`.
 */
export async function addPasskey(
  deps: AppDeps,
  user: UserRow,
  p: { ceremonyId: string; response: RegistrationResponseJSON; name: string | null },
): Promise<PasskeyRow> {
  const registration = await finishRegistration(deps, {
    purpose: 'add',
    ceremonyId: p.ceremonyId,
    response: p.response,
    userId: user.id,
  });
  const { db } = deps.db;
  if (await findPasskeyByCredentialId(db, registration.credentialId)) throw passkeyDuplicate();
  const name =
    p.name ??
    t('auth.passkey.numberedName', {
      number: (await credentialsOf(db, user.id)).passkeys + 1,
    });
  try {
    return await insertPasskey(db, { ...registration, name, now: deps.clock.now() });
  } catch (error) {
    // Another request registered the same credential between the check and the insert.
    if (isUniqueViolation(error)) throw passkeyDuplicate();
    throw error;
  }
}

/** Renames one of the user's passkeys. Not theirs, or unknown, is `not_found`. */
export async function renamePasskey(
  deps: AppDeps,
  userId: string,
  passkeyId: string,
  name: string,
): Promise<PasskeyRow> {
  const { db } = deps.db;
  const result = await db
    .updateTable('passkeys')
    .set({ name })
    .where('id', '=', passkeyId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw passkeyNotFound();
  return db
    .selectFrom('passkeys')
    .selectAll()
    .where('id', '=', passkeyId)
    .executeTakeFirstOrThrow();
}

/** Deletes one of the user's passkeys unless it is their last way to sign in. */
export async function deletePasskey(
  deps: AppDeps,
  userId: string,
  passkeyId: string,
): Promise<void> {
  await deps.db.db.transaction().execute(async (trx) => {
    await lockUser(trx, deps.db.dialect, userId);
    const found = await trx
      .selectFrom('passkeys')
      .select('id')
      .where('id', '=', passkeyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!found) throw passkeyNotFound();
    const { password, passkeys } = await credentialsOf(trx, userId);
    if (passkeys - 1 + (password ? 1 : 0) < 1) throw lastCredential();
    await trx.deleteFrom('passkeys').where('id', '=', passkeyId).execute();
  });
}
