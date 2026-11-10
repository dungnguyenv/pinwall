import { z } from 'zod';
import { Label } from './common.ts';
import { PasskeyRegistrationResponse } from './passkeys.ts';

/**
 * Length limits for a password a person chooses, counted in code points after NFKC
 * normalization. The server enforces them; the web app uses them to explain them up front.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** The token from the setup link printed in the server log. */
const SetupToken = z.string().min(1).max(200);

export const SetupTokenRequest = z.object({ token: SetupToken });
export type SetupTokenRequest = z.infer<typeof SetupTokenRequest>;

export const SetupPasskeyOptionsRequest = z.object({ token: SetupToken, name: Label });
export type SetupPasskeyOptionsRequest = z.infer<typeof SetupPasskeyOptionsRequest>;

/** Creates the owner account. A password, a passkey or both; `name` is the owner's name. */
export const SetupRequest = z.object({
  token: SetupToken,
  name: Label,
  email: z.email().max(254).nullable().optional(),
  password: z.string().min(1).max(1024).optional(),
  passkey: z
    .object({
      ceremony_id: z.string().min(1).max(200),
      response: PasskeyRegistrationResponse,
      /** What to call the passkey; a default name when left out. */
      name: Label.optional(),
    })
    .optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;
