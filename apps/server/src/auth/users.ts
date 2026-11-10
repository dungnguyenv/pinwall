import type { Me } from '@pinwall/shared';
import type { Kysely } from 'kysely';
import type { AuthContext } from '../app.ts';
import type { Database, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { effectiveRole } from './roles.ts';

/** The built-in owner account, or `undefined` while setup is still pending. */
export function getOwner(db: Kysely<Database>): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('kind', '=', 'owner').executeTakeFirst();
}

export async function ownerExists(db: Kysely<Database>): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('kind', '=', 'owner')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Which of its own sign-in methods the owner has set up. */
async function ownerCredentials(
  db: Kysely<Database>,
  userId: string,
): Promise<NonNullable<Me['credentials']>> {
  const [password, passkeys] = await Promise.all([
    db
      .selectFrom('password_credentials')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('passkeys')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow(),
  ]);
  return { password: password !== undefined, passkeys: Number(passkeys.n) };
}

/** The `Me` view of the caller. Only users with access get here (`resolveAuth` saw to it). */
export async function toMe(deps: AppDeps, auth: AuthContext): Promise<Me> {
  const { user } = auth;
  const role = effectiveRole(user);
  if (role !== 'admin' && role !== 'member') {
    throw new AppError('access_denied', 403, t('auth.accessDenied'));
  }
  return {
    id: user.id,
    kind: user.kind,
    name: user.name ?? user.email ?? '',
    email: user.email,
    email_verified: user.email_verified === 1,
    avatar_url: user.avatar_url,
    role,
    via: auth.via,
    credentials: user.kind === 'owner' ? await ownerCredentials(deps.db.db, user.id) : null,
    created_at: user.created_at,
  };
}
