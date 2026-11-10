import { z } from 'zod';

/**
 * A begun WebAuthn ceremony: `options` go to the browser's WebAuthn call as they are, and
 * `ceremony_id` comes back with the result. Only the challenge is described here; the rest is
 * the standard `PublicKeyCredential*OptionsJSON`.
 */
export const CeremonyOptions = z.object({
  ceremony_id: z.string(),
  options: z.looseObject({ challenge: z.string() }),
});
export type CeremonyOptions = z.infer<typeof CeremonyOptions>;

/** Fields every `PublicKeyCredential` JSON has; the server's WebAuthn library checks the rest. */
const credentialBase = {
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
};

/** What the browser returns from `navigator.credentials.create()`, as JSON. */
export const PasskeyRegistrationResponse = z.looseObject({
  ...credentialBase,
  response: z.looseObject({ clientDataJSON: z.string(), attestationObject: z.string() }),
});
export type PasskeyRegistrationResponse = z.infer<typeof PasskeyRegistrationResponse>;

/** What the browser returns from `navigator.credentials.get()`, as JSON. */
export const PasskeyAuthenticationResponse = z.looseObject({
  ...credentialBase,
  response: z.looseObject({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
  }),
});
export type PasskeyAuthenticationResponse = z.infer<typeof PasskeyAuthenticationResponse>;
