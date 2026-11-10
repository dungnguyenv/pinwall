/**
 * Folds text for accent-insensitive search: decomposes, drops combining marks, maps the
 * Vietnamese d-with-stroke (which has no decomposition), lowercases and collapses whitespace.
 * NFC and NFD input fold to the same string.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
