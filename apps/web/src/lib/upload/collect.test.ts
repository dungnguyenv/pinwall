import { expect, test } from 'vitest';
import type { PublicConfig } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { dir, fakeDrop, file, folderFile, sizedFile, unreadable } from '../../test/fake-entries.ts';
import { fx } from '../../test/fixtures.ts';
import {
  checkSelection,
  collectFromDataTransfer,
  collectFromFileList,
  hiddenFiles,
  selectionStats,
  UploadReadError,
  type UploadSelection,
  withoutHidden,
} from './collect.ts';
import { buildUploadForm } from './send.ts';

const t = i18n.t.bind(i18n);

function paths(s: UploadSelection | null): string[] {
  if (s?.kind !== 'files') throw new Error(`Expected files, got ${JSON.stringify(s)}`);
  return s.files.map((f) => f.path);
}

test.each(['site.zip', 'site.tar', 'site.tgz', 'site.tar.gz', 'SITE.ZIP'])(
  'a lone %s is sent as an archive',
  async (name) => {
    const s = await collectFromDataTransfer(fakeDrop([file(name, 10)]));
    expect(s?.kind).toBe('archive');
    expect(s?.kind === 'archive' && s.file.name).toBe(name);
    expect(collectFromFileList([new File(['x'], name)], { folder: false })?.kind).toBe('archive');
  },
);

test('an archive next to other files, or inside a folder, is just a file', async () => {
  expect(
    paths(await collectFromDataTransfer(fakeDrop([file('site.zip'), file('a.html')]))),
  ).toEqual(['a.html', 'site.zip']);
  expect(paths(await collectFromDataTransfer(fakeDrop([dir('out', [file('site.zip')])])))).toEqual([
    'out/site.zip',
  ]);
  expect(paths(await collectFromDataTransfer(fakeDrop([file('page.html')])))).toEqual([
    'page.html',
  ]);
});

test('loose files keep their names; a dropped folder keeps relative paths', async () => {
  expect(paths(await collectFromDataTransfer(fakeDrop([file('b.css'), file('a.html')])))).toEqual([
    'a.html',
    'b.css',
  ]);
  const site = dir('site', [file('index.html'), dir('css', [file('a.css')])]);
  expect(paths(await collectFromDataTransfer(fakeDrop([site])))).toEqual([
    'site/css/a.css',
    'site/index.html',
  ]);
});

test('macOS junk is left out and paths are NFC', async () => {
  const nfd = 'báo-cáo.html'; // "báo-cáo.html" decomposed, as macOS names files
  const site = dir('site', [
    file('index.html'),
    file('.DS_Store'),
    file('._index.html'),
    dir('__MACOSX', [file('index.html')]),
    file(nfd),
  ]);
  const s = await collectFromDataTransfer(fakeDrop([site, file('.DS_Store')]));
  expect(paths(s)).toEqual(['site/báo-cáo.html', 'site/index.html']);
  expect(paths(s)[0]).toBe('site/báo-cáo.html'.normalize('NFC'));
});

function skipped(s: UploadSelection | null): number {
  if (s?.kind !== 'files') throw new Error(`Expected files, got ${JSON.stringify(s)}`);
  return s.skipped ?? 0;
}

test('version-control folders are left out of a drop and counted', async () => {
  const site = dir('site', [
    file('index.html'),
    file('.gitignore'),
    dir('.git', [file('config'), file('HEAD'), dir('objects', [dir('ab', [file('cd12')])])]),
    dir('.svn', [file('entries')]),
    dir('docs', [dir('.hg', [file('store')]), file('a.md')]),
    // A submodule's .git is a file naming the real one.
    file('.GIT'),
  ]);
  const s = await collectFromDataTransfer(fakeDrop([site], { batch: 2 }));
  expect(paths(s)).toEqual(['site/.gitignore', 'site/docs/a.md', 'site/index.html']);
  // config, HEAD, cd12, entries, store and the .GIT file.
  expect(skipped(s)).toBe(6);

  // Dropped on its own, the folder leaves nothing to upload.
  const alone = await collectFromDataTransfer(fakeDrop([dir('.git', [file('config')])]));
  expect(paths(alone)).toEqual([]);
  expect(skipped(alone)).toBe(1);
});

test('version-control folders are left out of a picked folder and counted', () => {
  const s = collectFromFileList(
    [
      folderFile('site/index.html'),
      folderFile('site/.git/config'),
      folderFile('site/.git/objects/ab/cd12'),
      folderFile('site/.svn/entries'),
      folderFile('site/.github/workflows/ci.yml'),
    ],
    { folder: true },
  );
  expect(paths(s)).toEqual(['site/.github/workflows/ci.yml', 'site/index.html']);
  expect(skipped(s)).toBe(3);
  // Files picked one by one are checked the same way.
  const loose = collectFromFileList([new File([''], '.git'), new File([''], 'a.html')], {
    folder: false,
  });
  expect(paths(loose)).toEqual(['a.html']);
  expect(skipped(loose)).toBe(1);
});

test('a selection with nothing left out has no skipped count', async () => {
  expect(skipped(await collectFromDataTransfer(fakeDrop([file('a.html')])))).toBe(0);
  expect(skipped(collectFromFileList([folderFile('site/a.html')], { folder: true }))).toBe(0);
});

test('hiddenFiles finds every file with a dot in its path, and withoutHidden drops them', async () => {
  const s = await collectFromDataTransfer(
    fakeDrop([
      dir('site', [
        file('index.html'),
        file('.env'),
        file('.npmrc'),
        dir('.well-known', [file('security.txt')]),
        dir('css', [file('a.css'), file('.hidden.css')]),
        dir('.git', [file('config')]),
      ]),
    ]),
  );
  if (s?.kind !== 'files') throw new Error('Expected files');
  expect(hiddenFiles(s).map((f) => f.path)).toEqual([
    'site/.env',
    'site/.npmrc',
    'site/.well-known/security.txt',
    'site/css/.hidden.css',
  ]);
  const shown = withoutHidden(s);
  expect(paths(shown)).toEqual(['site/css/a.css', 'site/index.html']);
  // What was left out before is still counted.
  expect(skipped(shown)).toBe(1);

  // A dot inside a name is not hidden, and an archive is never searched.
  expect(
    hiddenFiles({ kind: 'files', files: [{ path: 'a.b/c.d.e', file: new File([], 'c.d.e') }] }),
  ).toEqual([]);
  expect(hiddenFiles({ kind: 'archive', file: new File([], '.env.zip') })).toEqual([]);
  expect(withoutHidden({ kind: 'archive', file: new File([], '.env.zip') }).kind).toBe('archive');
});

test('reads every entry of a large folder', async () => {
  const dt = fakeDrop(
    [
      dir(
        'big',
        Array.from({ length: 250 }, (_, i) => file(`f${i}.txt`)),
      ),
    ],
    {
      batch: 100,
    },
  );
  const s = await collectFromDataTransfer(dt);
  expect(s?.kind === 'files' && s.files.length).toBe(250);
});

test('reads every level of a nested folder', async () => {
  const deep = dir('a', [dir('b', [dir('c', [file('d.txt')]), file('e.txt')]), file('f.txt')]);
  expect(paths(await collectFromDataTransfer(fakeDrop([deep], { batch: 1 })))).toEqual([
    'a/b/c/d.txt',
    'a/b/e.txt',
    'a/f.txt',
  ]);
});

test('takes every entry before the drop event ends', async () => {
  const dt = fakeDrop(
    [dir('one', [file('1.html')]), dir('two', [file('2.html')]), dir('three', [file('3.html')])],
    { expires: true },
  );
  const s = await collectFromDataTransfer(dt);
  expect(paths(s)).toEqual(['one/1.html', 'three/3.html', 'two/2.html']);
  // The fake did go blank, as a browser's does.
  expect(dt.items).toHaveLength(0);
});

test('a drag without files gives nothing; an empty folder gives no files', async () => {
  expect(await collectFromDataTransfer(fakeDrop([], { types: ['text/plain'] }))).toBeNull();
  expect(paths(await collectFromDataTransfer(fakeDrop([dir('empty', [])])))).toEqual([]);
});

test('a file that cannot be read fails the whole selection, naming it', async () => {
  const dt = fakeDrop([dir('site', [file('index.html'), dir('img', [unreadable('gone.png')])])]);
  const error = await collectFromDataTransfer(dt).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UploadReadError);
  expect((error as UploadReadError).path).toBe('site/img/gone.png');
});

test('a folder input uses webkitRelativePath', () => {
  const s = collectFromFileList(
    [folderFile('site/index.html'), folderFile('site/css/a.css'), folderFile('site/.DS_Store')],
    { folder: true },
  );
  expect(paths(s)).toEqual(['site/css/a.css', 'site/index.html']);
  expect(selectionStats(s as UploadSelection).label).toBe('site');
  // A folder that holds only an archive is still a folder of files.
  expect(paths(collectFromFileList([folderFile('out/site.zip')], { folder: true }))).toEqual([
    'out/site.zip',
  ]);
  expect(collectFromFileList([], { folder: false })).toBeNull();
  expect(paths(collectFromFileList([], { folder: true }))).toEqual([]);
});

test('selectionStats sums the bytes and names the selection', () => {
  const zip = sizedFile('site.zip', 2_000);
  expect(selectionStats({ kind: 'archive', file: zip })).toEqual({
    bytes: 2_000,
    files: 1,
    label: 'site.zip',
  });
  const folder: UploadSelection = {
    kind: 'files',
    files: [
      { path: 'site/a.css', file: sizedFile('a.css', 10) },
      { path: 'site/index.html', file: sizedFile('index.html', 5) },
    ],
  };
  expect(selectionStats(folder)).toEqual({ bytes: 15, files: 2, label: 'site' });
  const loose: UploadSelection = {
    kind: 'files',
    files: [
      { path: 'a.html', file: sizedFile('a.html', 1) },
      { path: 'b.css', file: sizedFile('b.css', 1) },
      { path: 'c.js', file: sizedFile('c.js', 1) },
    ],
  };
  expect(selectionStats(loose).label).toBe(t('web.upload.andMore', { name: 'a.html', count: 2 }));
  expect(selectionStats(loose).label).toBe('a.html and 2 more');
  expect(selectionStats({ kind: 'files', files: [loose.files[0] as never] }).label).toBe('a.html');
});

test('checkSelection enforces the public limits', () => {
  const limits: PublicConfig['limits'] = { ...fx.config().limits, max_upload_bytes: 95_000_000 };
  const big: UploadSelection = { kind: 'archive', file: sizedFile('site.zip', 96_000_000) };
  expect(checkSelection(big, limits, t)).toBe(
    t('web.upload.tooLarge', { size: '96 MB', max: '95 MB' }),
  );
  expect(checkSelection(big, limits, t)).toBe(
    "This upload is 96 MB, over this Pinwall's limit of 95 MB per upload.",
  );
  expect(
    checkSelection({ kind: 'archive', file: sizedFile('site.zip', 95_000_000) }, limits, t),
  ).toBeNull();

  const three: UploadSelection = {
    kind: 'files',
    files: ['a', 'b', 'c'].map((n) => ({ path: n, file: sizedFile(n, 1) })),
  };
  expect(checkSelection(three, { ...limits, max_files: 2 }, t)).toBe(
    t('web.upload.tooManyFiles', { max: '2' }),
  );
  expect(checkSelection(three, { ...limits, max_files: 3 }, t)).toBeNull();
  expect(checkSelection({ kind: 'files', files: [] }, limits, t)).toBe(t('web.upload.empty'));
});

test('buildUploadForm orders target, then path before each file', () => {
  const html = new File(['<h1>x</h1>'], 'index.html', { type: 'text/html' });
  const css = new File(['a{}'], 'a.css', { type: 'text/css' });
  const entries = (f: FormData) =>
    [...f.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name]);

  const f = buildUploadForm(
    { project_id: 'prj_1' },
    {
      kind: 'files',
      files: [
        { path: 'site/index.html', file: html },
        { path: 'site/a.css', file: css },
      ],
    },
  );
  expect(entries(f)).toEqual([
    ['target', '{"project_id":"prj_1"}'],
    ['path', 'site/index.html'],
    ['file', 'index.html'],
    ['path', 'site/a.css'],
    ['file', 'a.css'],
  ]);

  const zip = new File(['PK'], 'site.zip');
  expect(entries(buildUploadForm({}, { kind: 'archive', file: zip }))).toEqual([
    ['target', '{}'],
    ['file', 'site.zip'],
  ]);
});
