// highlight.js is read from plain JavaScript on purpose. Its type definitions start with
// `/// <reference lib="dom" />`, which would swap the DOM types of `fetch`, `Request` and
// `ReadableStream` in for Node's across the whole server as soon as one TypeScript file imports
// them. TypeScript sees this module through `syntax-highlight.d.ts` only.
import hljs from 'highlight.js/lib/common';

export function highlightCode(code, language) {
  if (language === '' || hljs.getLanguage(language) === undefined) return null;
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
