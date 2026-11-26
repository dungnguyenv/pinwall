/*
 * Finds the bare http(s) URLs in plain text, such as a comment, so the UI can
 * show them as links. Nothing else in the text means anything: no Markdown, no
 * HTML. The parts spell the text exactly, so the line breaks and spaces around
 * a link stay as written.
 */

/** A run of the text as written, or a URL in it with the address its link opens. */
export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * `http://` or `https://` in any letter case, not glued to the end of a word
 * (`xhttps://` is not a URL), and what follows up to whitespace, a control
 * character, or `<`, `>`, `"` or a backtick, which a URL never holds as they
 * are and which often wrap one.
 */
const CANDIDATE = /(?<![a-z0-9])https?:\/\/[^\s\p{Cc}<>"`]*/giu;

/** Punctuation that ends a sentence rather than a URL when it comes last. */
const SENTENCE_END = new Set([...'.,;:!?…', ...'。、，；：！？']);

/** Each closing bracket or quote with the one that opens it. */
const OPENER_OF = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
  ['»', '«'],
  ['›', '‹'],
  ['”', '“'],
  ['’', '‘'],
  ['）', '（'],
  ['」', '「'],
  ['』', '『'],
  ['】', '【'],
]);
const OPENERS = new Set(OPENER_OF.values());

/** The quote that both opens and closes. */
const APOSTROPHE = "'";

/**
 * The candidate without what ends the sentence around it: trailing `.,;:!?`
 * and the like, and a closing bracket or quote the URL did not open itself, so
 * `(see https://a.com/x_(y))` keeps the inner pair and `https://a.com/x).`
 * loses `).`. Counts are kept as characters go, so the time stays linear.
 */
function trimEnd(candidate: string): string {
  const chars = [...candidate];
  const counts = new Map<string, number>();
  for (const char of chars) {
    if (OPENER_OF.has(char) || OPENERS.has(char) || char === APOSTROPHE) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  const count = (char: string) => counts.get(char) ?? 0;

  let end = chars.length;
  while (end > 0) {
    const last = chars[end - 1] as string;
    const opener = OPENER_OF.get(last);
    const drop =
      SENTENCE_END.has(last) ||
      (opener !== undefined && count(last) > count(opener)) ||
      // Paired inside the URL when there is an even number of them.
      (last === APOSTROPHE && count(last) % 2 === 1);
    if (!drop) break;
    counts.set(last, count(last) - 1);
    end--;
  }
  return chars.slice(0, end).join('');
}

/** The address an http(s) URL opens, or null when it is not one with a host. */
function httpHref(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A host of only dots, such as `https://.`, names nothing.
  if (!/[\p{L}\p{N}]/u.test(url.hostname)) return null;
  return url.href;
}

/**
 * Splits text into plain runs and http(s) links, in order. Only `http:` and
 * `https:` URLs written out in full become links; `javascript:`, `mailto:`,
 * a bare `www.` and the rest stay text.
 */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pushText = (run: string) => {
    if (run === '') return;
    const previous = parts.at(-1);
    if (previous?.kind === 'text') previous.text += run;
    else parts.push({ kind: 'text', text: run });
  };

  let done = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const url = trimEnd(match[0]);
    const href = httpHref(url);
    if (href === null) continue;
    pushText(text.slice(done, match.index));
    parts.push({ kind: 'link', text: url, href });
    done = match.index + url.length;
  }
  pushText(text.slice(done));
  return parts;
}
