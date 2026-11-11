/**
 * `code` highlighted as `language`: HTML-escaped text with `hljs-*` spans. Null when
 * highlight.js has no such language, a name or an alias (it never guesses one).
 */
export function highlightCode(code: string, language: string): string | null;
