import { z } from 'zod';
import { Timestamp } from './common.ts';

/**
 * A UTF-16 code unit of a surrogate pair standing alone. JSON can carry one (`"\ud800"`), and
 * neither database stores it faithfully: both turn it into U+FFFD, so two distinct names could
 * collide on the way in.
 */
const LONE_SURROGATE = /\p{Cs}/u;
const CONTROL = /\p{Cc}/u;

/** Text that is valid Unicode, without lone surrogates. */
export function wellFormed<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((text) => !LONE_SURROGATE.test(text), {
    message: 'Must be valid Unicode text (it holds a lone surrogate)',
  });
}

/** A local path an agent names so the upload command fits its files: no control characters. */
const PathHint = wellFormed(z.string().min(1).max(1024)).refine((text) => !CONTROL.test(text), {
  message: 'Must not contain control characters',
});

/**
 * Where a publish goes. `{ artifact_id, expected_version_id }` adds a version on top of the one
 * the publisher saw; anything else makes a new artifact, by default in the default project, named
 * after the entry page's title.
 */
export const PublishTargetInput = z.union([
  z.strictObject({ artifact_id: z.string(), expected_version_id: z.string() }),
  z.strictObject({
    project_id: z.string().nullable().optional(),
    name: wellFormed(z.string().trim().min(1).max(200)).optional(),
    tags: z.array(wellFormed(z.string())).max(20).optional(),
  }),
]);
export type PublishTargetInput = z.infer<typeof PublishTargetInput>;

/** The version message, shown in the history. */
const Message = wellFormed(z.string().max(2000));

/** `directory` and `file` name the local folder or file, so the commands can be run as given. */
export const CreatePublishSessionRequest = z.object({
  target: PublishTargetInput,
  message: Message.optional(),
  directory: PathHint.optional(),
  file: PathHint.optional(),
});
export type CreatePublishSessionRequest = z.infer<typeof CreatePublishSessionRequest>;

/** A one-time upload URL and the commands that publish to it. */
export const PublishSession = z.object({
  upload_url: z.string(),
  expires_at: Timestamp,
  commands: z.object({ archive: z.string(), single_file: z.string() }),
  max_upload_bytes: z.number().int(),
});
export type PublishSession = z.infer<typeof PublishSession>;

/** Something in the published files that may not work as the author expects. */
export const PublishWarning = z.object({
  code: z.literal('root_absolute_url'),
  file: z.string(),
  url: z.string(),
  message: z.string(),
});
export type PublishWarning = z.infer<typeof PublishWarning>;

/** The version a publish made, with the links to hand to people. */
export const PublishResult = z.object({
  artifact_id: z.string(),
  version_id: z.string(),
  version_number: z.number().int(),
  kind: z.enum(['html', 'markdown']),
  entry_path: z.string(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  /** The artifact's review page; it follows the newest version. */
  review_url: z.string(),
  /** The raw files of this version. */
  raw_url: z.string(),
  warnings: z.array(PublishWarning),
});
export type PublishResult = z.infer<typeof PublishResult>;

/** Text files given as strings, for clients that cannot run a shell command. */
export const InlinePublishRequest = z.object({
  target: PublishTargetInput,
  message: Message.optional(),
  files: z
    .array(z.object({ path: wellFormed(z.string().min(1).max(512)), content: z.string() }))
    .min(1)
    .max(1000),
});
export type InlinePublishRequest = z.infer<typeof InlinePublishRequest>;
