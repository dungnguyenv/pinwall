import { expect, test } from 'vitest';
import { type DiffLine, pairChanges, parseUnifiedDiff, wordSegments } from './unified-diff.ts';

test('parses hunks with line numbers', () => {
  const patch =
    'Index: b\n===================================================================\n--- b\tv1\n+++ b\tv2\n@@ -1,3 +1,3 @@\n a\n-2\n+22\n c\n';
  expect(parseUnifiedDiff(patch)).toEqual([
    {
      header: '@@ -1,3 +1,3 @@',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'context', text: 'a', oldNo: 1, newNo: 1 },
        { kind: 'del', text: '2', oldNo: 2, newNo: null },
        { kind: 'add', text: '22', oldNo: null, newNo: 2 },
        { kind: 'context', text: 'c', oldNo: 3, newNo: 3 },
      ],
    },
  ]);
});

test('added files, no-newline markers, CRLF and several hunks', () => {
  const added =
    '--- n.txt\tv1\n+++ n.txt\tv2\n@@ -0,0 +1,2 @@\n+one\r\n+two\n\\ No newline at end of file\n';
  expect(parseUnifiedDiff(added)).toEqual([
    {
      header: '@@ -0,0 +1,2 @@',
      oldStart: 0,
      newStart: 1,
      lines: [
        { kind: 'add', text: 'one', oldNo: null, newNo: 1 },
        { kind: 'add', text: 'two', oldNo: null, newNo: 2 },
      ],
    },
  ]);

  const two = [
    '--- s.css\tv1',
    '+++ s.css\tv2',
    '@@ -2,2 +2,2 @@',
    ' a {',
    '-  color: red;',
    '+  color: blue;',
    '@@ -40 +40 @@',
    '-x',
    '\\ No newline at end of file',
    '+y',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(two);
  expect(hunks.map((h) => [h.header, h.oldStart, h.newStart])).toEqual([
    ['@@ -2,2 +2,2 @@', 2, 2],
    ['@@ -40 +40 @@', 40, 40],
  ]);
  expect(hunks[1]?.lines).toEqual([
    { kind: 'del', text: 'x', oldNo: 40, newNo: null },
    { kind: 'add', text: 'y', oldNo: null, newNo: 40 },
  ]);
});

test('lines that look like file headers stay inside their hunk', () => {
  // A removed "-- note" line reads "--- note" in the patch, an added "++ x" line "+++ x".
  const patch = '--- q.sql\tv1\n+++ q.sql\tv2\n@@ -1,2 +1,2 @@\n--- note\n+++ x\n select 1;\n';
  expect(parseUnifiedDiff(patch)[0]?.lines).toEqual([
    { kind: 'del', text: '-- note', oldNo: 1, newNo: null },
    { kind: 'add', text: '++ x', oldNo: null, newNo: 1 },
    { kind: 'context', text: 'select 1;', oldNo: 2, newNo: 2 },
  ]);
  expect(parseUnifiedDiff('')).toEqual([]);
  expect(parseUnifiedDiff('Index: a\n===\n--- a\tv1\n+++ a\tv2\n')).toEqual([]);
});

test('changed lines pair up and changed words are marked', () => {
  expect(pairChanges([{ kind: 'del' }, { kind: 'del' }, { kind: 'add' }] as DiffLine[])).toEqual(
    new Map([[0, 2]]),
  );
  expect(wordSegments('price 10 USD', 'price 12 USD').del).toEqual([
    { text: 'price ', changed: false },
    { text: '10', changed: true },
    { text: ' USD', changed: false },
  ]);
  expect(wordSegments('price 10 USD', 'price 12 USD').add).toEqual([
    { text: 'price ', changed: false },
    { text: '12', changed: true },
    { text: ' USD', changed: false },
  ]);
});

test('runs pair separately and context ends a run', () => {
  const kinds = ['del', 'add', 'add', 'context', 'add', 'del', 'del', 'add'] as const;
  const lines = kinds.map((kind) => ({ kind }) as DiffLine);
  // del 0 ↔ add 1; add 4 has no del before it; dels 5, 6 ↔ add 7 (first only).
  expect(pairChanges(lines)).toEqual(
    new Map([
      [0, 1],
      [5, 7],
    ]),
  );
});

test('long lines are one changed segment', () => {
  const long = 'x'.repeat(501);
  expect(wordSegments(long, 'x')).toEqual({
    del: [{ text: long, changed: true }],
    add: [{ text: 'x', changed: true }],
  });
});
