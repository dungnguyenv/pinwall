import { z } from 'zod';
import { Timestamp } from './common.ts';

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
});
export type Me = z.infer<typeof Me>;
