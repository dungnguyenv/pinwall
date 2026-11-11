import { z } from 'zod';
import { Anchor } from '../protocol.ts';
import { page, Timestamp } from './common.ts';

/** C0 controls, DEL and C1 controls (Unicode's `Cc`). */
const CONTROL = /\p{Cc}/u;

/**
 * The text of a comment, trimmed: 1 to 10,000 characters, without NUL (Postgres cannot store
 * one). Line breaks and tabs are text like any other.
 */
export const CommentBody = z
  .string()
  .trim()
  .min(1)
  .max(10_000)
  .refine((text) => !text.includes('\u0000'), { message: 'Must not contain NUL characters' });
export type CommentBody = z.infer<typeof CommentBody>;

/**
 * The name a share-link guest signs a comment with, trimmed: 1 to 60 characters on one line, no
 * control characters.
 */
export const GuestName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((name) => !CONTROL.test(name), { message: 'Must not contain control characters' });
export type GuestName = z.infer<typeof GuestName>;

/** A version named by id and number. */
export const VersionRef = z.object({ id: z.string(), number: z.number().int() });
export type VersionRef = z.infer<typeof VersionRef>;

/** A member; both fields are null once their account is deleted. */
export const UserRef = z.object({ user_id: z.string().nullable(), name: z.string().nullable() });
export type UserRef = z.infer<typeof UserRef>;

/** Who wrote a comment: a member (null fields once their account is deleted) or a guest. */
export const CommentAuthor = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('member'),
    user_id: z.string().nullable(),
    name: z.string().nullable(),
  }),
  z.object({ type: z.literal('guest'), name: z.string() }),
]);
export type CommentAuthor = z.infer<typeof CommentAuthor>;

/**
 * One comment. `version` is the version it was written on; `thread_id` is the id of the thread's
 * first comment (its own id for that one). `edited_at` is set once its author changed its text.
 */
export const Comment = z.object({
  id: z.string(),
  thread_id: z.string(),
  artifact_id: z.string(),
  version: VersionRef,
  author: CommentAuthor,
  body: z.string(),
  created_at: Timestamp,
  updated_at: Timestamp,
  edited_at: Timestamp.nullable(),
});
export type Comment = z.infer<typeof Comment>;

/**
 * A thread: its first comment, where it points, whether it is resolved, and its replies, oldest
 * first. `resolved_in_version` is null when the thread is open, or when the version it was
 * resolved in has since been deleted.
 */
export const CommentThread = Comment.extend({
  anchor: Anchor,
  status: z.enum(['open', 'resolved']),
  resolved_in_version: VersionRef.nullable(),
  resolved_by: UserRef.nullable(),
  resolved_at: Timestamp.nullable(),
  replies: z.array(Comment),
});
export type CommentThread = z.infer<typeof CommentThread>;

export const CommentThreadList = page(CommentThread);
export type CommentThreadList = z.infer<typeof CommentThreadList>;

/** Which threads to list: by status, by the version they were written on, a page at a time. */
export const ThreadQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('all'),
  version: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).max(1000).optional(),
});
export type ThreadQuery = z.infer<typeof ThreadQuery>;

/** A new thread; without `version_id` it is written on the current version. */
export const CreateThreadRequest = z.object({
  body: CommentBody,
  anchor: Anchor,
  version_id: z.string().optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

/** A reply, or the new text of a comment. */
export const CommentBodyRequest = z.object({ body: CommentBody });
export type CommentBodyRequest = z.infer<typeof CommentBodyRequest>;

/** Without `version_id` the thread is resolved in the current version. */
export const ResolveRequest = z.object({ version_id: z.string().optional() });
export type ResolveRequest = z.infer<typeof ResolveRequest>;

/** A new thread from a share-link guest. */
export const GuestThreadRequest = z.object({
  guest_name: GuestName,
  body: CommentBody,
  anchor: Anchor,
});
export type GuestThreadRequest = z.infer<typeof GuestThreadRequest>;

/** A reply from a share-link guest. */
export const GuestReplyRequest = z.object({ guest_name: GuestName, body: CommentBody });
export type GuestReplyRequest = z.infer<typeof GuestReplyRequest>;

/**
 * What a guest gets back for a new comment: the thread it is in, its id, and the token that lets
 * the guest edit or delete it for a short while. The token is shown only here.
 */
export const GuestCreated = z.object({
  thread: CommentThread,
  comment_id: z.string(),
  guest_token: z.string(),
});
export type GuestCreated = z.infer<typeof GuestCreated>;
