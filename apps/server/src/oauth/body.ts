import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';

/**
 * The request body as text, at most `maxBytes`, read inside the handler so `oauthJson` shapes a
 * refusal: a declared length over the limit is refused before reading, and reading stops once
 * the body passes it. `tooLarge` makes the error thrown either way.
 */
export async function readBody(
  c: Context<AppEnv>,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<string> {
  const declared = Number(c.req.header('content-length'));
  if (declared > maxBytes) throw tooLarge();
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The media type of a `Content-Type` header, lowercased and without parameters. */
export function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
