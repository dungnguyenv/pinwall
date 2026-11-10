import { z } from 'zod';
import { Label, page, Timestamp } from './common.ts';

/** A personal API token as listed. The secret is shown only when the token is created. */
export const ApiToken = z.object({
  id: z.string(),
  name: z.string(),
  /** The first characters of the secret, so people can tell their tokens apart. */
  prefix: z.string(),
  created_at: Timestamp,
  last_used_at: Timestamp.nullable(),
  expires_at: Timestamp.nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;

export const ApiTokenList = page(ApiToken);
export type ApiTokenList = z.infer<typeof ApiTokenList>;

/** `expires_in_days` left out or `null` makes a token that never expires. */
export const CreateApiTokenRequest = z.object({
  name: Label,
  expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
});
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequest>;

/** The new token and its secret, the only time the secret is ever shown. */
export const CreatedApiToken = z.object({ token: ApiToken, secret: z.string() });
export type CreatedApiToken = z.infer<typeof CreatedApiToken>;
