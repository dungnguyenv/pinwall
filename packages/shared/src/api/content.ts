import { z } from 'zod';
import { Timestamp } from './common.ts';

/** `review` feeds the review frame; `raw` serves the stored bytes as they are. */
export const ContentMode = z.enum(['review', 'raw']);
export type ContentMode = z.infer<typeof ContentMode>;

/**
 * A short-lived URL to one version's files, in the isolation mode the server runs now. It stops
 * working at `expires_at` or when the mode changes, so it is never a link to keep: keep the
 * artifact's app links instead.
 */
export const ContentGrant = z.object({
  url: z.string(),
  mode: ContentMode,
  expires_at: Timestamp,
  isolation: z.enum(['single-domain', 'content-domain']),
});
export type ContentGrant = z.infer<typeof ContentGrant>;

export const PreviewQuery = z.object({ mode: ContentMode.default('review') });
export type PreviewQuery = z.infer<typeof PreviewQuery>;
