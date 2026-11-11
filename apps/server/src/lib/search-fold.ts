/**
 * Folded text is indexed up to this many bytes of UTF-8. Postgres refuses a tsvector whose words
 * add up to 1 MB or more, and unaccent can lengthen some characters, so this leaves room.
 */
export const SEARCH_BODY_MAX_BYTES = 512 * 1024;

/**
 * Folds text for accent-insensitive search: decomposes, drops combining marks, composes again,
 * maps the Vietnamese d-with-stroke (which has no decomposition), lowercases and collapses
 * whitespace. Composing again leaves only what has no mark, such as Hangul syllables, which
 * would otherwise stay split into two or three jamo each. NFC and NFD input fold to the same
 * string.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The start of folded `text` that fits in `maxBytes` of UTF-8: whole words only, unless the first
 * word alone is longer, which is then cut between code points.
 */
export function cutToUtf8Bytes(text: string, maxBytes: number): string {
  // No UTF-16 unit takes more than 3 bytes of UTF-8 (a surrogate pair takes 4 for 2 units).
  if (text.length * 3 <= maxBytes) return text;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back to the first byte of the code point the cut falls in.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const head = bytes.subarray(0, end).toString('utf8');
  if (bytes[end] === 0x20) return head.trimEnd();
  const space = head.lastIndexOf(' ');
  return space === -1 ? head : head.slice(0, space);
}
