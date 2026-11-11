import { z } from 'zod';

/** `limit` and `cursor` of every list route: 1 to 200 items, 50 unless asked. */
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1000).optional(),
});

/** An id in a path: not validated against any format, a wrong one is a 404. */
export const IdParam = z.object({ id: z.string().min(1).max(100) });

/** `{n}` in a path: a version number. */
export const VersionNumber = z.coerce.number().int().min(1);
