import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { CODEX_SIGN_IN, connectSnippets, SKILL_INSTALL } from './snippets.ts';

// docs/connect-an-agent.md repeats the connect page's snippets for a placeholder Pinwall; this
// keeps the two from drifting apart. (A path, not `new URL(…, import.meta.url)`: Vite turns
// that into an asset URL on the test page's http origin.)
const doc = readFileSync(
  resolve(import.meta.dirname, '../../../../../docs/connect-an-agent.md'),
  'utf8',
);

test('the connect doc shows exactly what the connect page generates', () => {
  const s = connectSnippets('https://pinwall.example');
  for (const snippet of [s.claudeCode, s.cursor, s.codex, s.mcpUrl, CODEX_SIGN_IN, SKILL_INSTALL]) {
    expect(doc).toContain(snippet);
  }
});
