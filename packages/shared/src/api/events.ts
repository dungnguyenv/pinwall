import { z } from 'zod';
import { CommentThread } from './comments.ts';

/** A change to a thread, with the thread as it is now. */
function threadEvent<T extends string>(type: T) {
  return z.object({ type: z.literal(type), artifact_id: z.string(), thread: CommentThread });
}

/**
 * A change to an artifact, as the live-update streams send it. `comment.deleted` carries the
 * thread as it is after the deletion, or null when the deleted comment was the thread's first,
 * which takes the whole thread with it.
 */
export const LiveEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('version.published'),
    artifact_id: z.string(),
    version_id: z.string(),
    number: z.number().int(),
  }),
  z.object({
    type: z.literal('version.deleted'),
    artifact_id: z.string(),
    number: z.number().int(),
  }),
  z.object({ type: z.literal('artifact.deleted'), artifact_id: z.string() }),
  threadEvent('comment.created'),
  threadEvent('comment.updated'),
  threadEvent('comment.resolved'),
  threadEvent('comment.reopened'),
  z.object({
    type: z.literal('comment.deleted'),
    artifact_id: z.string(),
    thread_id: z.string(),
    comment_id: z.string(),
    /** The number of the version the deleted comment was written on. */
    version_number: z.number().int(),
    thread: CommentThread.nullable(),
  }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** Every `type` a `LiveEvent` can have. */
export const LIVE_EVENT_TYPES: readonly LiveEvent['type'][] = LiveEvent.options.map(
  (option) => option.shape.type.value,
);
