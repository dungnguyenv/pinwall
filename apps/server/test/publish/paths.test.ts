import { expect, test } from 'vitest';
import {
  chooseEntry,
  MAX_PATH_LENGTH,
  normalizeEntryPath,
  RESERVED_DIR,
  rejectPath,
  stripWrapperFolder,
} from '../../src/publish/paths.ts';

test('normalizes NFD names to NFC', () => {
  expect(normalizeEntryPath('./caf\u0065\u0301.html')).toEqual({ path: 'caf\u00e9.html' });
  expect(normalizeEntryPath('././a/b.css')).toEqual({ path: 'a/b.css' });
  expect(normalizeEntryPath('Tài liệu/đề.md'.normalize('NFD'))).toEqual({
    path: 'Tài liệu/đề.md'.normalize('NFC'),
  });
});

test.each([
  ['/etc/passwd', 'absolute'],
  ['C:/x.html', 'absolute'],
  ['../x', 'dot_segment'],
  ['a/../b', 'dot_segment'],
  ['a/./b', 'dot_segment'],
  ['a\\b', 'backslash'],
  ['a\u0000b', 'control'],
  ['a\nb', 'control'],
  ['a\u007fb', 'control'],
  ['a\u0080b', 'control'],
  ['a\u0085b', 'control'],
  ['a\u009fb', 'control'],
  ['a\ud800.html', 'encoding'],
  ['a\udfff.html', 'encoding'],
  ['a//b', 'empty_segment'],
  ['x'.repeat(513), 'too_long'],
  ['__pinwall/x.js', 'reserved'],
  ['__pinwall', 'reserved'],
])('rejects %j as %s', (raw, reason) => {
  expect(() => normalizeEntryPath(raw)).toThrow(
    expect.objectContaining({
      status: 400,
      code: 'bad_request',
      details: expect.objectContaining({ reason }),
    }),
  );
});

test('characters next to the control ranges are allowed', () => {
  for (const name of ['a b', 'a~b', 'a\u00a0b', 'café', 'a\u00ffb']) {
    expect(normalizeEntryPath(`${name}.html`)).toEqual({ path: `${name}.html` });
  }
});

test('a lone surrogate is refused, a pair is a character like any other', () => {
  expect(normalizeEntryPath('\ud83d\ude00.html')).toEqual({ path: '😀.html' });
  expect(() => normalizeEntryPath('x/\ud800.html')).toThrow(
    expect.objectContaining({ details: { reason: 'encoding', path: 'x/\ufffd.html' } }),
  );
});

test('512 characters is allowed, counted in code points after NFC', () => {
  expect(normalizeEntryPath('é'.normalize('NFD').repeat(512))).toEqual({ path: 'é'.repeat(512) });
  // An astral character is two UTF-16 units but one code point.
  expect(normalizeEntryPath('😀'.repeat(MAX_PATH_LENGTH))).toEqual({
    path: '😀'.repeat(MAX_PATH_LENGTH),
  });
});

test('skips macOS junk and directories', () => {
  for (const p of ['__MACOSX/site/._index.html', 'site/._index.html', '.DS_Store', 'a/.DS_Store'])
    expect(normalizeEntryPath(p)).toEqual({ skip: 'junk' });
  for (const p of ['./', 'docs/', '.'])
    expect(normalizeEntryPath(p)).toEqual({ skip: 'directory' });
});

test('rejectPath quotes at most 100 characters of the path in the message', () => {
  const long = `${'a'.repeat(120)}.html`;
  const error = rejectPath(long, 'link');
  expect(error).toMatchObject({ status: 400, code: 'bad_request' });
  expect(error.message).toBe(
    `${'a'.repeat(100)}… is a symbolic or hard link, and links are not allowed. Archive the file itself (tar -h follows symlinks).`,
  );
  expect(error.details).toEqual({ reason: 'link', path: long });
  expect(rejectPath('x', 'too_long').message).toBe('x: paths can be at most 512 characters long.');
});

test('the details of an over-long path are capped too', () => {
  const huge = 'x'.repeat(10_000);
  const error = rejectPath(huge, 'too_long');
  expect(error.details).toEqual({ reason: 'too_long', path: `${'x'.repeat(512)}…` });
});

test('strips one wrapping folder', () => {
  expect(stripWrapperFolder(['site/index.html', 'site/a.css'])).toEqual({
    prefix: 'site/',
    paths: ['index.html', 'a.css'],
  });
  expect(stripWrapperFolder(['site/sub/index.html'])).toEqual({
    prefix: 'site/',
    paths: ['sub/index.html'],
  });
  for (const ps of [['index.html', 'site/a.css'], ['a/x', 'b/y'], ['only.html'], []])
    expect(stripWrapperFolder(ps)).toEqual({ prefix: null, paths: ps });
});

test('a wrapping folder is not stripped onto the reserved folder', () => {
  expect(() => stripWrapperFolder(['site/index.html', `site/${RESERVED_DIR}/x.js`])).toThrow(
    expect.objectContaining({
      status: 400,
      details: { reason: 'reserved', path: `site/${RESERVED_DIR}/x.js` },
    }),
  );
});

test('chooses the entry', () => {
  expect(chooseEntry(['a.css', 'index.md', 'index.html'])).toEqual({
    entryPath: 'index.html',
    kind: 'html',
  });
  expect(chooseEntry(['README.md', 'index.md'])).toEqual({
    entryPath: 'index.md',
    kind: 'markdown',
  });
  expect(chooseEntry(['README.md', 'x.png'])).toEqual({ entryPath: 'README.md', kind: 'markdown' });
  expect(chooseEntry(['report.pdf'])).toEqual({ entryPath: 'report.pdf', kind: 'html' });
  expect(chooseEntry(['notes.MD'])).toEqual({ entryPath: 'notes.MD', kind: 'markdown' });
  expect(() => chooseEntry(['a.html', 'b.html'])).toThrow(
    expect.objectContaining({ details: { reason: 'no_entry' } }),
  );
  expect(() => chooseEntry(['docs/index.html', 'docs/a.css'])).toThrow(
    expect.objectContaining({ details: { reason: 'no_entry' } }),
  );
  expect(() => chooseEntry([])).toThrow(expect.objectContaining({ details: { reason: 'empty' } }));
});

test('entry errors carry the English copy', () => {
  expect(() => chooseEntry([])).toThrow('The upload contains no files.');
  expect(() => chooseEntry(['a.html', 'b.html'])).toThrow(
    'No entry page found. Name the main page index.html or index.md.',
  );
});
