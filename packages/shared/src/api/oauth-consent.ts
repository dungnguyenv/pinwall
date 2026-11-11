import { z } from 'zod';

/*
 * The consent page's API (session only). `GET /api/v1/oauth/requests/:id`
 * describes an authorization request waiting for the signed-in person;
 * `POST /api/v1/oauth/requests/:id/decision` records their answer. M7 defines
 * these shapes and M6's routes serve them.
 */

/**
 * Who asks and where the answer goes. `client_name` and `client_uri` are what
 * the client said about itself when it registered, so they are unverified
 * text. `redirect_host` is the host of the redirect URI the answer goes to.
 * `user` is the person the grant would be for.
 */
export const OAuthConsentRequest = z.object({
  client_name: z.string(),
  client_uri: z.string().nullable(),
  redirect_host: z.string(),
  scopes: z.array(z.string()),
  user: z.object({ name: z.string(), email: z.string().nullable() }),
});
export type OAuthConsentRequest = z.infer<typeof OAuthConsentRequest>;

export const OAuthDecisionRequest = z.object({ approve: z.boolean() });
export type OAuthDecisionRequest = z.infer<typeof OAuthDecisionRequest>;

/** Where the browser goes next: the client's redirect URI with the code or the refusal. */
export const OAuthDecisionResult = z.object({ redirect_to: z.string() });
export type OAuthDecisionResult = z.infer<typeof OAuthDecisionResult>;
