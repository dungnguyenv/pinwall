import type { z } from 'zod';
import { badRequest } from './errors.ts';
import { t } from './i18n.ts';

/** An opaque page marker for list endpoints: the values the next page starts after. */
export function encodeCursor(values: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/** Reads a cursor made by `encodeCursor`. Anything else is a `bad_request`. */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest(t('error.cursor'));
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(t('error.cursor'));
  return parsed.data;
}
