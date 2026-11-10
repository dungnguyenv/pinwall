import { z } from 'zod';
import { Label, page, Timestamp } from './common.ts';
import { PasskeyRegistrationResponse } from './passkeys.ts';

/** Fields left out stay as they are; `email: null` removes the owner's email. */
export const UpdateProfileRequest = z.object({
  name: Label.optional(),
  email: z.email().max(254).nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

/**
 * `current_password` is required once the owner has a password and left out when they have
 * none (a passkey-only owner adding one). The server checks `new_password` against the
 * password length limits.
 */
export const ChangePasswordRequest = z.object({
  current_password: z.string().min(1).max(1024).optional(),
  new_password: z.string().min(1).max(1024),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** A passkey as listed; the key material never leaves the server. */
export const Passkey = z.object({
  id: z.string(),
  name: z.string(),
  /** What the authenticator reported, for example `internal` or `usb`; may be empty. */
  transports: z.array(z.string()),
  created_at: Timestamp,
  last_used_at: Timestamp.nullable(),
});
export type Passkey = z.infer<typeof Passkey>;

export const PasskeyList = page(Passkey);
export type PasskeyList = z.infer<typeof PasskeyList>;

/** Finishes adding a passkey begun with `POST /me/passkeys/options`. */
export const AddPasskeyRequest = z.object({
  ceremony_id: z.string().min(1).max(200),
  response: PasskeyRegistrationResponse,
  /** What to call the passkey; "Passkey <n>" when left out. */
  name: Label.optional(),
});
export type AddPasskeyRequest = z.infer<typeof AddPasskeyRequest>;

export const RenamePasskeyRequest = z.object({ name: Label });
export type RenamePasskeyRequest = z.infer<typeof RenamePasskeyRequest>;
