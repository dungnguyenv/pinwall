/**
 * The encoding an HTML file's bytes are in, as a browser would choose it from the bytes alone, so
 * that the `charset` Pinwall labels the file with agrees with what the page says about itself (an
 * HTTP charset overrides a page's own `<meta charset>`).
 *
 * A byte order mark decides first. Without one, the first 1024 bytes are scanned for a
 * `<meta charset>` or `<meta http-equiv="Content-Type" content="…; charset=…">` the way the WHATWG
 * HTML standard's prescan does ("prescan a byte stream to determine its encoding"), and the label
 * found is resolved to its standard encoding name. A page with neither is UTF-8.
 */
export function htmlCharset(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return prescan(bytes.subarray(0, PRESCAN_BYTES).toString('latin1')) ?? 'utf-8';
}

const PRESCAN_BYTES = 1024;

const isSpace = (ch: string | undefined) =>
  ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r' || ch === ' ';
const isLetter = (ch: string | undefined) => ch !== undefined && /^[A-Za-z]$/.test(ch);

/** The encoding the first `<meta>` that declares a known one names, or null. */
function prescan(s: string): string | null {
  let at = 0;
  while (at < s.length) {
    if (s.startsWith('<!--', at)) {
      // `<!-->` ends the comment it opens, as `-->` does.
      const end = s.indexOf('-->', at + 2);
      if (end < 0) return null;
      at = end + 3;
      continue;
    }
    if (
      s.slice(at, at + 5).toLowerCase() === '<meta' &&
      (isSpace(s[at + 5]) || s[at + 5] === '/')
    ) {
      const meta = readMeta(s, at + 5);
      if (meta === EOF) return null;
      if (meta.encoding !== null) return meta.encoding;
      at = meta.end + 1;
      continue;
    }
    if (s[at] === '<' && (isLetter(s[at + 1]) || (s[at + 1] === '/' && isLetter(s[at + 2])))) {
      // Another tag: its attribute values may hold `<` and `>`, so they are read and passed over.
      at += 1;
      while (at < s.length && !isSpace(s[at]) && s[at] !== '>') at += 1;
      const end = readAttributes(s, at, () => {});
      if (end === EOF) return null;
      at = end + 1;
      continue;
    }
    if (s[at] === '<' && (s[at + 1] === '!' || s[at + 1] === '/' || s[at + 1] === '?')) {
      const end = s.indexOf('>', at + 2);
      if (end < 0) return null;
      at = end + 1;
      continue;
    }
    at += 1;
  }
  return null;
}

/**
 * Reads the attributes of a `<meta>` from `at`: `encoding` is what it declares, if anything, and
 * `end` the index of its `>`.
 */
function readMeta(s: string, at: number): { encoding: string | null; end: number } | typeof EOF {
  const seen = new Set<string>();
  let gotPragma = false;
  let needPragma: boolean | null = null;
  let label: string | null = null;
  const end = readAttributes(s, at, (name, value) => {
    // The first of two attributes with one name counts.
    if (seen.has(name)) return;
    seen.add(name);
    if (name === 'http-equiv' && value === 'content-type') gotPragma = true;
    if (name === 'content' && label === null) {
      const declared = charsetInContent(value);
      if (declared !== null) {
        label = declared;
        needPragma = true;
      }
    }
    if (name === 'charset') {
      label = value;
      needPragma = false;
    }
  });
  if (end === EOF) return EOF;
  if (label === null || needPragma === null || (needPragma && !gotPragma)) {
    return { encoding: null, end };
  }
  return { encoding: encodingFor(label), end };
}

/** The charset a `content` value such as `text/html; charset=windows-1258` names, or null. */
function charsetInContent(value: string): string | null {
  const match = /charset[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r ;]+))/.exec(
    value,
  );
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The standard name of the encoding `label` names, after the HTML standard's two corrections: a
 * page cannot declare UTF-16 from inside (it reads as UTF-8), and `x-user-defined` is
 * windows-1252. Null for a label the runtime does not know, which the scan then passes over.
 */
function encodingFor(label: string): string | null {
  let name: string;
  try {
    name = new TextDecoder(label).encoding;
  } catch {
    return null;
  }
  if (name === 'utf-16le' || name === 'utf-16be') return 'utf-8';
  if (name === 'x-user-defined') return 'windows-1252';
  return name;
}

/** The scanned bytes ran out inside a tag: the scan ends there, finding nothing. */
const EOF = Symbol('eof');

/**
 * Reads a tag's attributes from `at`, passing each to `onAttribute`, and returns the index of the
 * `>` that ends the tag.
 */
function readAttributes(
  s: string,
  at: number,
  onAttribute: (name: string, value: string) => void,
): number | typeof EOF {
  let i = at;
  for (;;) {
    const attribute = readAttribute(s, i);
    if (attribute === EOF || typeof attribute === 'number') return attribute;
    onAttribute(attribute.name, attribute.value);
    i = attribute.end;
  }
}

/**
 * One attribute from `at`, names and values lower-cased, with the index just past it; or, at the
 * end of the tag, the index of its `>`. Attribute values in quotes may hold `>`.
 */
function readAttribute(
  s: string,
  at: number,
): { name: string; value: string; end: number } | number | typeof EOF {
  let i = at;
  while (isSpace(s[i]) || s[i] === '/') i += 1;
  if (i >= s.length) return EOF;
  if (s[i] === '>') return i;
  let name = '';
  for (;;) {
    const ch = s[i];
    if (ch === undefined) return EOF;
    if (ch === '=' && name !== '') break;
    if (isSpace(ch)) {
      while (isSpace(s[i])) i += 1;
      if (s[i] !== '=') return { name, value: '', end: i };
      break;
    }
    if (ch === '/' || ch === '>') return { name, value: '', end: i };
    name += ch.toLowerCase();
    i += 1;
  }
  i += 1;
  while (isSpace(s[i])) i += 1;
  const quote = s[i];
  if (quote === undefined) return EOF;
  if (quote === '"' || quote === "'") {
    const close = s.indexOf(quote, i + 1);
    if (close < 0) return EOF;
    return { name, value: s.slice(i + 1, close).toLowerCase(), end: close + 1 };
  }
  if (quote === '>') return { name, value: '', end: i };
  let value = '';
  while (i < s.length && !isSpace(s[i]) && s[i] !== '>') {
    value += (s[i] as string).toLowerCase();
    i += 1;
  }
  return i >= s.length ? EOF : { name, value, end: i };
}
