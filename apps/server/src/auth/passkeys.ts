import type { Kysely, Transaction } from 'kysely';
import type { Database, PasskeyRow } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';
import type { PasskeyRegistration } from './webauthn.ts';

/** A connection or an open transaction: services pass whichever they are working in. */
export type Db = Kysely<Database> | Transaction<Database>;

export async function insertPasskey(
  db: Db,
  p: PasskeyRegistration & { name: string; now: number },
): Promise<PasskeyRow> {
  const row: PasskeyRow = {
    id: newId('pky'),
    user_id: p.userId,
    credential_id: p.credentialId,
    public_key: p.publicKey,
    counter: p.counter,
    transports: JSON.stringify(p.transports),
    name: p.name,
    created_at: p.now,
    last_used_at: null,
  };
  await db.insertInto('passkeys').values(row).execute();
  return row;
}

export function findPasskeyByCredentialId(
  db: Db,
  credentialId: string,
): Promise<PasskeyRow | undefined> {
  return db
    .selectFrom('passkeys')
    .selectAll()
    .where('credential_id', '=', credentialId)
    .executeTakeFirst();
}

/** The user's passkeys, oldest first. */
export function listPasskeys(db: Db, userId: string): Promise<PasskeyRow[]> {
  return db
    .selectFrom('passkeys')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** Stores the sign counter of a verified assertion and when it happened. */
export async function recordPasskeyUse(
  db: Db,
  id: string,
  counter: number,
  now: number,
): Promise<void> {
  await db
    .updateTable('passkeys')
    .set({ counter, last_used_at: now })
    .where('id', '=', id)
    .execute();
}
