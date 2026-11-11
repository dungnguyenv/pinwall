import { z } from 'zod';

/**
 * Output schemas of the MCP tools. The SDK publishes each one as the tool's `outputSchema` and
 * checks every `structuredContent` against it before answering.
 */

/** `whoami`: the caller, how they connected, and what this Pinwall accepts. */
export const WhoamiOut = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.enum(['admin', 'member']),
  }),
  via: z.enum(['oauth', 'api_token']),
  pinwall_url: z.string(),
  isolation: z.enum(['single-domain', 'content-domain']),
  limits: z.object({
    max_upload_bytes: z.number().int(),
    max_inline_bytes: z.number().int(),
    max_file_bytes: z.number().int(),
    max_version_bytes: z.number().int(),
    max_files: z.number().int(),
  }),
  upload_url_ttl_seconds: z.number().int(),
  authoring_notes: z.array(z.string()),
});
export type WhoamiOut = z.infer<typeof WhoamiOut>;
