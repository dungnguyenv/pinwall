import { createHash } from 'node:crypto';

/**
 * The stylesheet of the server-rendered pages (error and sign-in result pages): style B, white
 * and greys, system sans-serif, a black rounded button; dark when the system is dark.
 */
export const PAGES_CSS = `:root {
  color-scheme: light dark;
  --pw-bg: #ffffff;
  --pw-subtle: #f4f4f5;
  --pw-text: #18181b;
  --pw-muted: #63636b;
  --pw-border: #e4e4e7;
  --pw-primary-bg: #18181b;
  --pw-primary-text: #ffffff;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --pw-bg: #1c1c1f;
    --pw-subtle: #27272a;
    --pw-text: #ededef;
    --pw-muted: #a1a1aa;
    --pw-border: #3a3a3f;
    --pw-primary-bg: #ededef;
    --pw-primary-text: #18181b;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  margin: 0;
}

body {
  background: var(--pw-bg);
  color: var(--pw-text);
  font-size: 16px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.pw-page {
  display: flex;
  min-height: 100%;
  align-items: center;
  justify-content: center;
  padding: 48px 20px;
}

.pw-panel {
  width: 100%;
  max-width: 440px;
  text-align: center;
}

.pw-status {
  margin: 0 0 8px;
  color: var(--pw-muted);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.pw-title {
  margin: 0 0 12px;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
}

.pw-message {
  margin: 0 0 28px;
  color: var(--pw-muted);
}

.pw-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 0 0 32px;
}

.pw-button {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  padding: 8px 20px;
  border: 1px solid var(--pw-border);
  border-radius: 999px;
  color: var(--pw-text);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}

.pw-button:hover {
  background: var(--pw-subtle);
}

.pw-button-primary {
  border-color: var(--pw-primary-bg);
  background: var(--pw-primary-bg);
  color: var(--pw-primary-text);
}

.pw-button-primary:hover {
  background: var(--pw-primary-bg);
  opacity: 0.85;
}

.pw-button:focus-visible {
  outline: 2px solid var(--pw-text);
  outline-offset: 2px;
}

.pw-meta {
  margin: 0;
  color: var(--pw-muted);
  font-size: 13px;
}

.pw-meta code {
  padding: 2px 6px;
  border: 1px solid var(--pw-border);
  border-radius: 6px;
  background: var(--pw-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  user-select: all;
}
`;

export const PAGES_CSS_PATH = '/_pinwall/pages.css';

/**
 * What pages link to: the path plus a content hash, so the stylesheet can be cached for a year
 * and an upgrade that changes it is still picked up at once.
 */
export const PAGES_CSS_HREF = `${PAGES_CSS_PATH}?v=${createHash('sha256').update(PAGES_CSS).digest('hex').slice(0, 12)}`;
