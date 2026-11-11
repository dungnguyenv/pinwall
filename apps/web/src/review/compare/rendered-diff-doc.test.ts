import { expect, test } from 'vitest';
import type { MarkdownDiff } from '../../api/dto.ts';
import { renderedDiffDocument } from './rendered-diff-doc.ts';

const labels = { removed: 'Removed', added: 'Added', changed: 'Changed' };

test('blocks are marked and the document is self-contained', () => {
  const blocks: MarkdownDiff['blocks'] = [
    { op: 'unchanged', old_html: '<h1>Plans</h1>', new_html: '<h1>Plans</h1>' },
    { op: 'added', old_html: null, new_html: '<p>Brand new</p>' },
    { op: 'removed', old_html: '<p>Gone now</p>', new_html: null },
    { op: 'changed', old_html: '<p>B1</p>', new_html: '<p>B2</p>' },
  ];
  const doc = renderedDiffDocument(blocks, labels);

  expect(doc.startsWith('<!doctype html>')).toBe(true);
  expect(doc).toContain('<meta charset="utf-8">');
  expect(doc).toContain('<meta name="color-scheme" content="light dark">');
  expect(doc.match(/<style>/g)).toHaveLength(1);
  expect(doc).toContain('prefers-color-scheme: dark');
  expect(doc).toContain('<section class="pw-u"><h1>Plans</h1></section>');
  expect(doc).toMatch(/<section class="pw-a">.*<p>Brand new<\/p><\/section>/);
  expect(doc).toMatch(/<section class="pw-d">.*<p>Gone now<\/p><\/section>/);
  expect(doc).toMatch(
    /<section class="pw-c">.*<div class="pw-old"><p>B1<\/p><\/div><div class="pw-new"><p>B2<\/p><\/div><\/section>/,
  );
  // The labels name each kind of block in words, not by color alone.
  for (const word of ['Added', 'Removed', 'Changed']) expect(doc).toContain(`>${word}<`);

  // Nothing of Pinwall's own runs or loads: no script, no URL.
  expect(doc).not.toMatch(/<script/i);
  expect(doc).not.toMatch(/https?:\/\//i);
  expect(doc).not.toMatch(/url\(|@import/i);
});

test('block HTML is passed through as it is; labels are escaped', () => {
  const blocks: MarkdownDiff['blocks'] = [
    { op: 'added', old_html: null, new_html: '<script>alert(1)</script>' },
  ];
  const doc = renderedDiffDocument(blocks, { ...labels, added: '<b>New</b> & "x"' });
  // The artifact's HTML stays inside its block (the frame's sandbox keeps it inert).
  expect(doc.match(/<script/g)).toHaveLength(1);
  expect(doc).toContain('&lt;b&gt;New&lt;/b&gt; &amp; &quot;x&quot;');
  expect(doc).not.toContain('<b>New</b>');
});

test('no blocks is still a whole document', () => {
  const doc = renderedDiffDocument([], labels);
  expect(doc).toContain('<body>');
  expect(doc.endsWith('</html>')).toBe(true);
});
