import type { MarkdownDiff } from '../../api/dto.ts';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/*
 * The document's own look: Pinwall's prose and diff styles in both themes.
 * The colors are the app's tokens (styles/tokens.css), written out because the
 * frame is a separate document. Added and removed blocks carry a tint, a mark
 * in the gutter (+, −) and a label in words, so color is never the only cue;
 * the status colors reach 4.5:1 on their tints and the text on every tint.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #0d0d0d;
  --muted: #5e5e5e;
  --line: #e6e6e6;
  --soft: #f4f4f4;
  --link: #3a44c4;
  --add: #1f7a3a;
  --add-bg: #e6f4ea;
  --del: #c62828;
  --del-bg: #fdecec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a1c;
    --fg: #ececec;
    --muted: #a6a6ad;
    --line: #2f2f33;
    --soft: #2a2a2e;
    --link: #a5abff;
    --add: #4cc27a;
    --add-bg: #1a3323;
    --del: #f26d6d;
    --del-bg: #3b1f21;
  }
}
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: break-word;
}
*, *::before, *::after { box-sizing: border-box; }
main { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.5em; font-weight: 600; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.375rem; }
h3 { font-size: 1.125rem; }
h4, h5, h6 { font-size: 1rem; }
p, ul, ol, blockquote, pre, table, dl { margin: 0.75em 0; }
ul, ol { padding-left: 1.5em; }
li + li { margin-top: 0.25em; }
a { color: var(--link); text-underline-offset: 2px; }
img, video { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.75em 0; }
blockquote { margin-left: 0; padding: 0.1em 1em; border-left: 3px solid var(--line); color: var(--muted); }
code, pre, kbd, samp {
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.875em;
}
:not(pre) > code { padding: 0.1em 0.35em; border-radius: 4px; background: var(--soft); }
pre { padding: 0.85em 1em; border-radius: 8px; background: var(--soft); overflow-x: auto; line-height: 1.5; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
th, td { padding: 0.4em 0.75em; border: 1px solid var(--line); text-align: left; }
th { background: var(--soft); font-weight: 600; }
section { margin: 0.5rem 0; }
.pw-u { padding: 0 0.85rem 0 1.75rem; }
.pw-a, .pw-d, .pw-old, .pw-new { position: relative; padding: 0.6rem 0.85rem 0.6rem 1.75rem; }
.pw-a, .pw-d { border-radius: 8px; }
.pw-a, .pw-new { background: var(--add-bg); }
.pw-d, .pw-old { background: var(--del-bg); }
.pw-c { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.pw-c > .pw-tag { position: relative; z-index: 1; margin: 0.6rem 0.85rem 0 0.75rem; }
section > :first-child, .pw-old > :first-child, .pw-new > :first-child,
.pw-tag + * { margin-top: 0; }
section > :last-child, .pw-old > :last-child, .pw-new > :last-child { margin-bottom: 0; }
.pw-a::before, .pw-d::before, .pw-old::before, .pw-new::before {
  position: absolute;
  left: 0.5rem;
  top: 0.6rem;
  font: 600 15px/1.65 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.pw-a::before, .pw-new::before { content: "+"; color: var(--add); }
.pw-d::before, .pw-old::before { content: "\\2212"; color: var(--del); }
.pw-tag {
  float: right;
  margin: 0 0 0.25rem 0.75rem;
  padding: 0 0.55rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  font: 600 12px/18px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.pw-a > .pw-tag { color: var(--add); }
.pw-d > .pw-tag { color: var(--del); }
.pw-c > .pw-tag { color: var(--muted); border-color: var(--line); background: var(--soft); }
`;

/**
 * A whole HTML document showing a rendered Markdown diff, for an
 * `<iframe sandbox="" srcdoc>`: never parsed in the app's own document. Each
 * block's HTML is the artifact's, passed through as it is (the empty sandbox
 * keeps it from running anything); unchanged blocks show their new HTML,
 * removed ones their old, and changed ones the old above the new. The labels
 * name added, removed and changed blocks in words. The document's own policy
 * lets it load nothing but data: images, so it makes no request at all.
 */
export function renderedDiffDocument(
  blocks: MarkdownDiff['blocks'],
  labels: { removed: string; added: string; changed: string },
): string {
  const tag = (label: string) => `<span class="pw-tag">${escapeHtml(label)}</span>`;
  const body = blocks
    .map((block) => {
      switch (block.op) {
        case 'unchanged':
          return `<section class="pw-u">${block.new_html ?? block.old_html ?? ''}</section>`;
        case 'added':
          return `<section class="pw-a">${tag(labels.added)}${block.new_html ?? ''}</section>`;
        case 'removed':
          return `<section class="pw-d">${tag(labels.removed)}${block.old_html ?? ''}</section>`;
        case 'changed':
          return (
            `<section class="pw-c">${tag(labels.changed)}` +
            `<div class="pw-old">${block.old_html ?? ''}</div>` +
            `<div class="pw-new">${block.new_html ?? ''}</div></section>`
          );
      }
      return '';
    })
    .join('\n');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="color-scheme" content="light dark">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<style>${STYLE}</style></head><body><main>\n${body}\n</main></body></html>`
  );
}
