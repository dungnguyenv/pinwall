/**
 * Pinwall's own stylesheet for rendered Markdown pages, served at `__pinwall/markdown.css`.
 * Neutral and quiet: a readable measure, system fonts, light and dark by the viewer's setting.
 * It loads nothing (no import, font, image or URL), so it works inside the sandbox and on a
 * content host alike. The token colors are Pinwall's own, grouped into a few roles.
 */
export const markdownCss = `
:root {
  color-scheme: light dark;
  --pw-bg: #ffffff;
  --pw-fg: #1d1f23;
  --pw-muted: #5c616b;
  --pw-faint: #868b95;
  --pw-line: #e1e3e8;
  --pw-soft: #f4f5f7;
  --pw-link: #1b5fc1;
  --pw-link-hover: #0f3f8a;
  --pw-accent: #2f6fdf;
  --pw-mark: #fff3bf;
  --pw-tok-keyword: #5b3fc4;
  --pw-tok-string: #1d7a4f;
  --pw-tok-number: #a8500a;
  --pw-tok-title: #0b6bcb;
  --pw-tok-type: #0f766e;
  --pw-tok-attr: #8a3b8f;
  --pw-tok-tag: #b4233f;
  --pw-tok-comment: #5f6672;
  --pw-tok-add: #16603c;
  --pw-tok-add-bg: #e3f5ea;
  --pw-tok-del: #a11d33;
  --pw-tok-del-bg: #fbe7ea;
}

@media (prefers-color-scheme: dark) {
  :root {
    --pw-bg: #17181b;
    --pw-fg: #e4e6ea;
    --pw-muted: #a3a8b3;
    --pw-faint: #7d828d;
    --pw-line: #2c2f36;
    --pw-soft: #202227;
    --pw-link: #7db0ff;
    --pw-link-hover: #a9c9ff;
    --pw-accent: #5b95f0;
    --pw-mark: #4a4017;
    --pw-tok-keyword: #b8a6ff;
    --pw-tok-string: #82d6a6;
    --pw-tok-number: #f0ab6c;
    --pw-tok-title: #80baff;
    --pw-tok-type: #62d4c9;
    --pw-tok-attr: #e3a8e8;
    --pw-tok-tag: #ff93a6;
    --pw-tok-comment: #959baa;
    --pw-tok-add: #7fd9a2;
    --pw-tok-add-bg: #17301f;
    --pw-tok-del: #ff9aab;
    --pw-tok-del-bg: #3a1a20;
  }
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  margin: 0;
  background: var(--pw-bg);
  color: var(--pw-fg);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: break-word;
}

/* Layout: the article alone is centered; with a table of contents it sits in a side column. */
.pw-md {
  box-sizing: border-box;
  max-width: 50rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}

.pw-md *,
.pw-md *::before,
.pw-md *::after {
  box-sizing: border-box;
}

.pw-toc {
  margin: 0 0 2rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--pw-line);
  border-radius: 8px;
  background: var(--pw-soft);
  font-size: 0.9rem;
  line-height: 1.4;
}

.pw-toc ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.pw-toc li {
  margin: 0;
  padding: 0.2rem 0;
}

.pw-toc .pw-toc-h3 {
  padding-left: 1rem;
}

.pw-toc a {
  color: var(--pw-muted);
  text-decoration: none;
}

.pw-toc a:hover,
.pw-toc a:focus-visible {
  color: var(--pw-link);
  text-decoration: underline;
}

@media (min-width: 70rem) {
  .pw-md:has(> .pw-toc) {
    display: grid;
    grid-template-columns: 14.5rem minmax(0, 46rem);
    column-gap: 3rem;
    max-width: 66rem;
    align-items: start;
  }

  .pw-md:has(> .pw-toc) > .pw-toc {
    position: sticky;
    top: 1.5rem;
    max-height: calc(100vh - 3rem);
    margin: 0.4rem 0 0;
    padding: 0 0 0 1rem;
    overflow-y: auto;
    border: 0;
    border-left: 2px solid var(--pw-line);
    border-radius: 0;
    background: transparent;
  }
}

/* Typography */
.pw-md-body {
  min-width: 0;
}

.pw-md-body > :first-child {
  margin-top: 0;
}

.pw-md-body > :last-child {
  margin-bottom: 0;
}

.pw-md-body h1,
.pw-md-body h2,
.pw-md-body h3,
.pw-md-body h4,
.pw-md-body h5,
.pw-md-body h6 {
  margin: 2em 0 0.6em;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.01em;
  scroll-margin-top: 1.5rem;
}

.pw-md-body h1 {
  margin-top: 0;
  font-size: 2rem;
  letter-spacing: -0.02em;
}

.pw-md-body h2 {
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--pw-line);
  font-size: 1.5rem;
}

.pw-md-body h3 {
  font-size: 1.2rem;
}

.pw-md-body h4 {
  font-size: 1rem;
}

.pw-md-body h5,
.pw-md-body h6 {
  color: var(--pw-muted);
  font-size: 0.9rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pw-md-body p,
.pw-md-body ul,
.pw-md-body ol,
.pw-md-body blockquote,
.pw-md-body pre,
.pw-md-body table,
.pw-md-body details,
.pw-md-body figure {
  margin: 0 0 1.1em;
}

.pw-md-body ul,
.pw-md-body ol {
  padding-left: 1.6em;
}

.pw-md-body li {
  margin: 0.25em 0;
}

.pw-md-body li > ul,
.pw-md-body li > ol {
  margin: 0.25em 0 0;
}

.pw-md-body li > p {
  margin: 0.5em 0;
}

.pw-md-body a {
  color: var(--pw-link);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.15em;
}

.pw-md-body a:hover {
  color: var(--pw-link-hover);
}

.pw-md-body :focus-visible {
  outline: 2px solid var(--pw-accent);
  outline-offset: 2px;
}

.pw-md-body strong {
  font-weight: 650;
}

.pw-md-body mark {
  background: var(--pw-mark);
  color: inherit;
}

.pw-md-body hr {
  height: 0;
  margin: 2em 0;
  border: 0;
  border-top: 1px solid var(--pw-line);
}

.pw-md-body blockquote {
  padding: 0.1em 1em;
  border-left: 3px solid var(--pw-line);
  color: var(--pw-muted);
}

.pw-md-body blockquote > :last-child {
  margin-bottom: 0;
}

.pw-md-body img,
.pw-md-body video {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 0 1.1em;
  border-radius: 6px;
}

.pw-md-body p > img:only-child {
  margin-bottom: 0;
}

.pw-md-body details {
  padding: 0.6em 1em;
  border: 1px solid var(--pw-line);
  border-radius: 8px;
}

.pw-md-body summary {
  cursor: pointer;
  font-weight: 600;
}

.pw-md-body details[open] > summary {
  margin-bottom: 0.6em;
}

.pw-md-body kbd {
  padding: 0.1em 0.4em;
  border: 1px solid var(--pw-line);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--pw-soft);
  font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* Tables scroll sideways rather than widen the page. */
.pw-md-body table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 0.95em;
}

.pw-md-body th,
.pw-md-body td {
  padding: 0.45em 0.85em;
  border: 1px solid var(--pw-line);
  text-align: left;
  vertical-align: top;
}

.pw-md-body th {
  background: var(--pw-soft);
  font-weight: 600;
}

.pw-md-body tbody tr:nth-child(even) td {
  background: color-mix(in srgb, var(--pw-soft) 55%, transparent);
}

/* Code */
.pw-md-body code,
.pw-md-body pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

.pw-md-body code {
  padding: 0.12em 0.35em;
  border-radius: 4px;
  background: var(--pw-soft);
  font-size: 0.88em;
}

.pw-md-body pre {
  padding: 0.9em 1.1em;
  overflow-x: auto;
  border: 1px solid var(--pw-line);
  border-radius: 8px;
  background: var(--pw-soft);
  font-size: 0.875rem;
  line-height: 1.55;
  tab-size: 4;
}

.pw-md-body pre code {
  padding: 0;
  background: none;
  font-size: inherit;
}

/* A source shown as text because it was too large to format. */
.pw-md-notice {
  margin: 0 0 1.1em;
  padding: 0.7em 1em;
  border: 1px solid var(--pw-line);
  border-left: 3px solid var(--pw-accent);
  border-radius: 6px;
  background: var(--pw-soft);
  color: var(--pw-muted);
  font-size: 0.92rem;
}

.pw-md-body pre.pw-md-source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Code tokens, by role */
.hljs-keyword,
.hljs-selector-tag,
.hljs-literal,
.hljs-meta .hljs-keyword,
.hljs-template-tag {
  color: var(--pw-tok-keyword);
}

.hljs-string,
.hljs-regexp,
.hljs-meta .hljs-string,
.hljs-symbol,
.hljs-bullet,
.hljs-code {
  color: var(--pw-tok-string);
}

.hljs-number,
.hljs-link {
  color: var(--pw-tok-number);
}

.hljs-title,
.hljs-title.function_,
.hljs-section,
.hljs-selector-id {
  color: var(--pw-tok-title);
}

.hljs-type,
.hljs-built_in,
.hljs-class .hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-selector-class {
  color: var(--pw-tok-type);
}

.hljs-attr,
.hljs-attribute,
.hljs-property,
.hljs-variable,
.hljs-template-variable,
.hljs-params,
.hljs-selector-attr,
.hljs-selector-pseudo {
  color: var(--pw-tok-attr);
}

.hljs-tag,
.hljs-name,
.hljs-doctag,
.hljs-formula {
  color: var(--pw-tok-tag);
}

.hljs-comment,
.hljs-quote,
.hljs-meta,
.hljs-operator,
.hljs-punctuation {
  color: var(--pw-tok-comment);
}

.hljs-comment,
.hljs-quote,
.hljs-emphasis {
  font-style: italic;
}

.hljs-strong,
.hljs-section {
  font-weight: 650;
}

.hljs-addition {
  background: var(--pw-tok-add-bg);
  color: var(--pw-tok-add);
}

.hljs-deletion {
  background: var(--pw-tok-del-bg);
  color: var(--pw-tok-del);
}

@media print {
  body {
    background: #fff;
    color: #000;
  }

  .pw-md {
    max-width: none;
    padding: 0;
  }

  .pw-toc {
    display: none;
  }

  .pw-md-body pre {
    white-space: pre-wrap;
  }
}
`;
