/**
 * Scanners for the URLs in attribute and stylesheet text. They only read strings: nothing is
 * fetched or resolved, and each runs in one pass over its input.
 */

const isBlank = (code: number) => code === 32 || (code >= 9 && code <= 13);

/** Candidate URLs of a `srcset` value: each candidate's URL, without its descriptor. */
export function* srcsetUrls(value: string): Generator<string> {
  let at = 0;
  while (at < value.length) {
    while (at < value.length && (isBlank(value.charCodeAt(at)) || value[at] === ',')) at++;
    const start = at;
    while (at < value.length && !isBlank(value.charCodeAt(at))) at++;
    let end = at;
    // A URL that ends in commas has no descriptors; the commas are separators.
    while (end > start && value[end - 1] === ',') end--;
    if (end > start) yield value.slice(start, end);
    if (end === at) {
      // Skip the descriptors up to the next candidate.
      while (at < value.length && value[at] !== ',') at++;
    }
  }
}

const isCssIdentifier = (code: number) =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 45 ||
  code === 95;

/**
 * The URLs a stylesheet loads, in order. One pass: comments and strings are skipped as CSS skips
 * them, so a `url(` inside either is not a reference, and every position is visited once whatever
 * the input looks like.
 */
export function* cssUrls(css: string): Generator<string> {
  const length = css.length;
  let at = 0;
  while (at < length) {
    const code = css.charCodeAt(at);
    if (code === 47 && css.charCodeAt(at + 1) === 42) {
      // A comment.
      const close = css.indexOf('*/', at + 2);
      at = close === -1 ? length : close + 2;
    } else if (code === 34 || code === 39) {
      at = readCssString(css, at).end;
    } else if (code === 64 && css.slice(at + 1, at + 7).toLowerCase() === 'import') {
      at += 7;
      while (at < length && isBlank(css.charCodeAt(at))) at++;
      const quote = css.charCodeAt(at);
      if (quote === 34 || quote === 39) {
        const read = readCssString(css, at);
        yield read.value;
        at = read.end;
      }
    } else if (
      (code | 0x20) === 0x75 &&
      (css.charCodeAt(at + 1) | 0x20) === 0x72 &&
      (css.charCodeAt(at + 2) | 0x20) === 0x6c &&
      css.charCodeAt(at + 3) === 40 &&
      !(at > 0 && isCssIdentifier(css.charCodeAt(at - 1)))
    ) {
      at += 4;
      while (at < length && isBlank(css.charCodeAt(at))) at++;
      const quote = css.charCodeAt(at);
      if (quote === 34 || quote === 39) {
        const read = readCssString(css, at);
        yield read.value;
        at = read.end;
      } else {
        const close = css.indexOf(')', at);
        yield css.slice(at, close === -1 ? length : close).trim();
        at = close === -1 ? length : close + 1;
      }
    } else {
      at++;
    }
  }
}

/** A CSS string starting at its opening quote: its value and the index after it. */
function readCssString(css: string, start: number): { value: string; end: number } {
  const quote = css.charCodeAt(start);
  let value = '';
  let at = start + 1;
  let from = at;
  while (at < css.length) {
    const code = css.charCodeAt(at);
    if (code === quote) {
      return { value: value + css.slice(from, at), end: at + 1 };
    }
    if (code === 10) break; // An unescaped newline ends a string that was never closed.
    if (code === 92) {
      value += css.slice(from, at) + (css[at + 1] ?? '');
      at += 2;
      from = at;
    } else {
      at++;
    }
  }
  return { value: value + css.slice(from, at), end: at };
}
