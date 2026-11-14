import { z } from 'zod';
import { Timestamp } from './common.ts';
import { PasskeyAuthenticationResponse } from './passkeys.ts';

/** The signed-in user, and how this request was authenticated. */
export const Me = z.object({
  id: z.string(),
  kind: z.enum(['owner', 'oidc']),
  name: z.string(),
  email: z.string().nullable(),
  email_verified: z.boolean(),
  avatar_url: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  via: z.enum(['session', 'api_token', 'oauth']),
  /** The owner's own sign-in methods; `null` for IdP users, who sign in at the IdP. */
  credentials: z
    .object({ password: z.boolean(), passkeys: z.number().int().nonnegative() })
    .nullable(),
  created_at: Timestamp,
  /**
   * Whether this person may make share links and open raw links. Sent only when links need an
   * admin's approval (`PINWALL_SHARE_LINKS=approved`); absent means everyone may.
   */
  can_create_share_links: z.boolean().optional(),
  /**
   * What this person's space holds. Sent, with `limits`, in `personal` mode or when a quota
   * applies to them; absent means there is no quota to show. `files` (the files of all their
   * versions) is optional in the schema and always sent.
   */
  usage: z
    .object({
      bytes: z.number().int(),
      artifacts: z.number().int(),
      files: z.number().int().optional(),
    })
    .optional(),
  /** What this person may store; `null` is no limit. Sent with `usage`, `files` always included. */
  limits: z
    .object({
      bytes: z.number().int().nullable(),
      artifacts: z.number().int().nullable(),
      files: z.number().int().nullable().optional(),
    })
    .optional(),
});
export type Me = z.infer<typeof Me>;

export const PasswordSignInRequest = z.object({ password: z.string().min(1).max(1024) });
export type PasswordSignInRequest = z.infer<typeof PasswordSignInRequest>;

/** Finishes a passkey sign-in begun with `POST /auth/passkey/options`. */
export const PasskeySignInRequest = z.object({
  ceremony_id: z.string().min(1).max(200),
  response: PasskeyAuthenticationResponse,
});
export type PasskeySignInRequest = z.infer<typeof PasskeySignInRequest>;
