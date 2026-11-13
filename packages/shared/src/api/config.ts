import { z } from 'zod';

/** What the sign-in and setup screens need before anyone is signed in. */
export const PublicConfig = z.object({
  setup_required: z.boolean(),
  oidc: z.object({ enabled: z.boolean(), display_name: z.string().nullable() }),
  isolation: z.enum(['single-domain', 'content-domain']),
  passkeys_available: z.boolean(),
  /** Sent only in `personal` mode, where each person has a space of their own; absent means `team`. */
  visibility: z.enum(['team', 'personal']).optional(),
  limits: z.object({
    max_upload_bytes: z.number().int(),
    max_inline_bytes: z.number().int(),
    max_file_bytes: z.number().int(),
    max_version_bytes: z.number().int(),
    max_files: z.number().int(),
    max_expansion_ratio: z.number().int(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfig>;
