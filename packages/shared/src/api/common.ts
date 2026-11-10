import { z } from 'zod';

/** The body of every error response: `{ "error": { "code", "message", "details"? } }`. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Epoch milliseconds. */
export const Timestamp = z.number().int();
export type Timestamp = z.infer<typeof Timestamp>;

/** A name a person gives to something: a user, a passkey or an API token. */
export const Label = z.string().trim().min(1).max(100);
export type Label = z.infer<typeof Label>;

/** A page of a list: `next_cursor` is `null` on the last page. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}
