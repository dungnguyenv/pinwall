# Pinwall M4a — Publishing Core: Ingest, Blobs, Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The service layer of publishing, tested below HTTP. It covers path rules and limits; tar, tar.gz and zip readers; content-addressed blob staging with lease-aware garbage collection and tombstones; metadata and search-text extraction; projects; the version commit with optimistic concurrency, plus restore; and one ingest pipeline for uploads, file sets and inline text.

**Architecture:** `publish/` turns a byte stream or a file set into staged blobs: path rules, limits, archive readers, the stager, ingest. `domain/` owns rows: projects, artifacts, versions, the commit, search reindexing, tombstones, blob GC. `content/` gets the MIME map and metadata extraction. Blob safety comes from an in-process `BlobRegistry` (per-sha lock plus pins), a `blobs` row written before the bytes, and the `maintenance:backup` lease. Together they keep any blob that an upload or a version needs. This plan adds no routes; M4b puts these services on HTTP.

**Tech Stack:** Kysely, tar-stream 3, `node:zlib`, fflate 0.8 (raw DEFLATE), htmlparser2 12, markdown-it 15 + markdown-it-anchor 10, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` (§3.3–3.6, §3.10; acceptance 7–10 server side).

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` holds the shared names, data model, routes and Security model. Its Global Constraints apply to every task.

**Depends on:** M1 (`…-m1-foundation.md`) and M2 (`…-m2-identity.md`). This plan uses M1's `AppDeps`, `BlobStore`, `LeaseManager`, `EventBus`, `createTestContext`, `dialects`, `publicUrl`, `searchUpsert`/`searchDelete`/`searchQuery` with `DbScope`, and M2's `Db` and `createSignedInUser`. Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.

**Split:** M4 is split into two plans that share one task numbering:
- this one, Tasks 1–6, at the service level;
- `2026-11-10-pinwall-m4b-publishing-http.md`, Tasks 7–13: HTTP, content serving, deletion.

M4b starts once Tasks 1–6 are committed on the M4 branch and consumes the interface listed below.

**Worktree:** M4 runs on its own worktree in parallel with M3. Keep code in `publish/`, `content/`, `domain/` and the new `api/` files. Shared files get additive lines only: `app.ts`, `main.ts`, `api/router.ts`, `db/schema.ts`, `db/migrations/index.ts`, `test/db/migrate.test.ts`, `packages/shared/src/api/index.ts` and `en.json`. Put every new en.json key in one block grouped by prefix (`publish.*`, `content.*`, `project.*`, `artifact.*`, `version.*`).

## Global Constraints

The roadmap's Global Constraints apply, plus these for M4:
- **Limits, verbatim:** `PINWALL_MAX_UPLOAD_BYTES` (request, counted while streaming), `PINWALL_MAX_FILE_BYTES`, `PINWALL_MAX_VERSION_BYTES`, `PINWALL_MAX_FILES`, `PINWALL_MAX_EXPANSION_RATIO`, `PINWALL_MAX_INLINE_BYTES`, read from `config.limits`. TTLs from `config.ttl.previewMs` (`PINWALL_PREVIEW_TTL`) and `config.ttl.uploadSessionMs` (`PINWALL_UPLOAD_SESSION_TTL`).
- **Atomic publish.** A rejected publish commits no artifact, version or file row. Every blob the failed upload added that no version references is removed.
- **Paths** are stored in NFC, at most 512 characters, relative, without `.`/`..`/empty segments, backslashes or control characters. `__pinwall/` is reserved in every version.
- **Content response headers, verbatim:** `Cache-Control: private, max-age=300, no-transform`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. In single-domain mode only, add `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation`. Content responses never read or set cookies and never carry app headers (`frame-ancestors`, `X-Frame-Options`). Content is authorized only by the token.
- **Links people hold live on the app origin** (`/a/:id`, `/a/:id/raw`, `/a/:id/v/:n/raw`). Content URLs are built per request from the current `config.isolation` and are never returned as permanent links.
- **Raw grants serve stored bytes unchanged** in both modes: no re-encoding, no charset conversion, no injection.
- **Version numbers are never reused.** The next number is `artifacts.latest_number + 1`, so the link of a deleted version answers gone, not someone else's content.
- **Both databases:** DB tests run in `describe.each(dialects)`. Search indexing during a commit or a delete goes through `searchUpsert/searchDelete({ db: trx, dialect })`, inside the transaction.
- **One migration:** `0002_publishing` (Task 3). It is the only schema change in M4.
- **i18n:** every message a person can read goes through `t()`, with the exact copy given in the task. Messages quote at most the first 100 characters of a path, ending in `…`.

## Review Focus

The list covers all of M4. Tasks 1–6 are in M4a, Tasks 7–13 in M4b.

1. **Unicode from macOS.** Archive names arrive in NFD, while links in HTML are NFC and percent-encoded. Vietnamese `đ` has no decomposition. Expected: names are stored in NFC, a request in either form or encoding finds the file, and NFC/NFD twins in one archive count as duplicates. → Task 1 `normalizes NFD names to NFC`; Task 6 `NFD names are stored in NFC` and `a rejected upload …: duplicate`; Task 9 `finds a file whatever the normalization form and percent-encoding`.
2. **An agent retries an upload.** The retry comes after a success whose response was lost, or after the URL expired. Expected: no duplicate version. The error says the URL was used and names the version it made, or says it expired and how to get a new one. → Task 7 `a retried upload names the version it created`, `an expired session says how to get a new one`.
3. **An upload rejected mid-stream:** too large, too many files, expansion bomb, traversal, link, absolute path. Expected: a 4xx naming the exact reason and limit, no version row, no orphaned blob. → Task 6 `a rejected upload leaves no version and no orphan blobs: %s`; Task 7 `an oversized streamed body is 413 without Content-Length`.
4. **Archives made on macOS or by hand:** `__MACOSX/`, `._*`, `.DS_Store`, and a lone wrapping folder (`tar -czf site.tgz site/`). Expected: junk skipped, folder stripped, entry page found. → Task 1 `skips macOS junk and directories`, `strips one wrapping folder`; Task 6 `macOS junk is skipped and a wrapping folder stripped`.
5. **The documented command as curl really sends it.** curl sends the body chunked, without `Content-Length`, with `Content-Type: application/x-www-form-urlencoded` and `Expect: 100-continue`. Expected: Pinwall detects the archive by its magic bytes, counts the limit on streamed bytes, and publishes. → Task 6 `curl's default content type is ignored for archives`; Task 7 `the documented command publishes over a real socket`.

## Interface handed to M4b

The exact signatures are in each task's Interfaces block.
- **Paths and limits:** `publish/paths.ts` (`normalizeEntryPath`, `rejectPath`, `stripWrapperFolder`, `chooseEntry`); `publish/limits.ts` (`IngestBudget`, `limitExceeded`); `content/mime.ts` (`contentTypeFor`, `isTextType`, `isRasterImage`).
- **Archives:** `publish/archive.ts` (`sniffArchive`, `readArchive`); test helpers `makeTar`, `makeZip`.
- **Tombstones and blobs:** `domain/tombstones.ts` (`addTombstones`, `isTombstoned`, `pruneTombstones`); `domain/blobs.ts` (`BACKUP_LEASE`, `collectBlobs`, `sweepBlobs`).
- **Metadata:** `content/metadata.ts` (`PublishWarning`, `VersionMetadata`, `extractVersionText`).
- **Projects:** `domain/projects.ts` (`DEFAULT_PROJECT_ID`, `ensureDefaultProject`, `getProject`, `createProject`, `updateProject`).
- **Artifacts:** `domain/artifacts.ts` (`getArtifact`, `lockArtifact`, `normalizeTags`, `getTags`).
- **Versions:** `domain/versions.ts` (`PublishTarget`, `checkTarget`, `commitVersion`, `restoreVersion`, `getVersionByNumber`).
- **Search and events:** `domain/search.ts` (`indexArtifact`, `reindexArtifact`, `ARTIFACT_TOPIC`).
- **Ingest:** `publish/ingest.ts` (`ingestUpload`, `ingestFiles`, `ingestInline`, `publishLinks`, `PublishOptions`, `PublishOutcome`, `UploadInput`); test helper `publishFiles`.
- **Later milestones:**
  - M5 uses `isTombstoned(db, 'share_link', token_hash)` and `ARTIFACT_TOPIC`.
  - M6 uses `ingestInline`.
  - M9 uses `BACKUP_LEASE` and backs up the `tombstones` table.

---

### Task 1: Path rules, MIME types and ingest limits (model: opus)

**Files:**
- Create: `apps/server/src/publish/{paths.ts,limits.ts}`, `apps/server/src/content/mime.ts`
- Modify: `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/publish/{paths,limits}.test.ts`, `apps/server/test/content/mime.test.ts`

**Interfaces:**
- Consumes (M1): `AppError`, `badRequest`, `payloadTooLarge`, `t`, `Config['limits']`, `ArtifactKind`.
- Produces:

```ts
// publish/paths.ts
export const MAX_PATH_LENGTH = 512;
export const RESERVED_DIR = '__pinwall';
export type PathRejection = 'absolute' | 'dot_segment' | 'backslash' | 'control' | 'empty_segment' | 'too_long'
  | 'duplicate' | 'reserved' | 'link' | 'special';
export function rejectPath(path: string, reason: PathRejection): AppError;   // badRequest(t(`publish.path.${reason}`, { path, max }), { reason, path })
export function normalizeEntryPath(raw: string): { path: string } | { skip: 'junk' | 'directory' };   // throws rejectPath
export function stripWrapperFolder(paths: readonly string[]): { prefix: string | null; paths: string[] };
export function chooseEntry(paths: readonly string[]): { entryPath: string; kind: ArtifactKind };
  // badRequest(t('publish.entry.empty'), { reason: 'empty' }) | badRequest(t('publish.entry.none'), { reason: 'no_entry' })
// publish/limits.ts
export type LimitName = 'max_upload_bytes' | 'max_file_bytes' | 'max_version_bytes' | 'max_files' | 'max_expansion_ratio' | 'max_inline_bytes';
export const EXPANSION_FLOOR_BYTES = 65_536;
export function limitExceeded(limit: LimitName, max: number, path?: string): AppError;   // payloadTooLarge(t(`publish.limit.${limit}`, …), { limit, max, path? })
export class IngestBudget {
  constructor(limits: Config['limits']);
  onRequestBytes(n: number): void;       // running total > maxUploadBytes → max_upload_bytes
  onExpandedBytes(n: number): void;      // expanded > maxExpansionRatio × max(request bytes, EXPANSION_FLOOR_BYTES) → max_expansion_ratio
  startFile(path: string, declaredSize: number | null): void;   // file count > maxFiles → max_files; declared > maxFileBytes → max_file_bytes
  onFileBytes(n: number): void;          // current file > maxFileBytes → max_file_bytes (with path); all files > maxVersionBytes → max_version_bytes
}
// content/mime.ts
export function contentTypeFor(path: string): string;
export function isTextType(contentType: string): boolean;     // text/*, javascript, json, xml, image/svg+xml
export function isRasterImage(contentType: string): boolean;  // png, jpeg, webp, gif, avif
```

- [ ] **Step 1: Write the failing tests.**

```ts
test('normalizes NFD names to NFC', () => {
  expect(normalizeEntryPath('./caf\u0065\u0301.html')).toEqual({ path: 'caf\u00e9.html' });
  expect(normalizeEntryPath('././a/b.css')).toEqual({ path: 'a/b.css' });
  expect(normalizeEntryPath('Tài liệu/đề.md'.normalize('NFD'))).toEqual({ path: 'Tài liệu/đề.md'.normalize('NFC') });
});
test.each([
  ['/etc/passwd', 'absolute'], ['C:/x.html', 'absolute'], ['../x', 'dot_segment'], ['a/../b', 'dot_segment'],
  ['a/./b', 'dot_segment'], ['a\\b', 'backslash'], ['a\u0000b', 'control'], ['a\nb', 'control'],
  ['a//b', 'empty_segment'], ['x'.repeat(513), 'too_long'], ['__pinwall/x.js', 'reserved'],
])('rejects %j as %s', (raw, reason) => {
  expect(() => normalizeEntryPath(raw)).toThrow(expect.objectContaining({ status: 400, code: 'bad_request', details: expect.objectContaining({ reason }) }));
});
test('512 characters is allowed, counted in code points after NFC', () => {
  expect(normalizeEntryPath('é'.normalize('NFD').repeat(512))).toEqual({ path: 'é'.repeat(512) });
});
test('skips macOS junk and directories', () => {
  for (const p of ['__MACOSX/site/._index.html', 'site/._index.html', '.DS_Store', 'a/.DS_Store'])
    expect(normalizeEntryPath(p)).toEqual({ skip: 'junk' });
  for (const p of ['./', 'docs/', '.']) expect(normalizeEntryPath(p)).toEqual({ skip: 'directory' });
});
test('strips one wrapping folder', () => {
  expect(stripWrapperFolder(['site/index.html', 'site/a.css'])).toEqual({ prefix: 'site/', paths: ['index.html', 'a.css'] });
  expect(stripWrapperFolder(['site/sub/index.html'])).toEqual({ prefix: 'site/', paths: ['sub/index.html'] });
  for (const ps of [['index.html', 'site/a.css'], ['a/x', 'b/y'], ['only.html']])
    expect(stripWrapperFolder(ps).prefix).toBeNull();
});
test('chooses the entry', () => {
  expect(chooseEntry(['a.css', 'index.md', 'index.html'])).toEqual({ entryPath: 'index.html', kind: 'html' });
  expect(chooseEntry(['README.md', 'index.md'])).toEqual({ entryPath: 'index.md', kind: 'markdown' });
  expect(chooseEntry(['README.md', 'x.png'])).toEqual({ entryPath: 'README.md', kind: 'markdown' });
  expect(chooseEntry(['report.pdf'])).toEqual({ entryPath: 'report.pdf', kind: 'html' });
  expect(() => chooseEntry(['a.html', 'b.html'])).toThrow(expect.objectContaining({ details: { reason: 'no_entry' } }));
  expect(() => chooseEntry([])).toThrow(expect.objectContaining({ details: { reason: 'empty' } }));
});
// limits.test.ts — L = { maxUploadBytes: 1000, maxInlineBytes: 100, maxFileBytes: 300, maxVersionBytes: 500, maxFiles: 2, maxExpansionRatio: 10 }
test('request bytes over the limit', () => {
  const b = new IngestBudget(L); b.onRequestBytes(1000);
  expect(() => b.onRequestBytes(1)).toThrow(expect.objectContaining({ status: 413, code: 'payload_too_large', details: { limit: 'max_upload_bytes', max: 1000 } }));
});
test('file, version and count limits', ...);   // startFile('a', 301) → max_file_bytes, details.path 'a'; startFile('a', null) + onFileBytes(301) → same;
  // two files of 250 → ok, then onFileBytes(1) → max_version_bytes; startFile × 3 → max_files
test('expansion ratio uses a 64 KiB floor', ...);   // onRequestBytes(1000); onExpandedBytes(655_360) ok; onExpandedBytes(1) → max_expansion_ratio
// mime.test.ts
test('maps extensions case-insensitively', ...);   // 'A.HTML' → 'text/html; charset=utf-8'; 'x.css' → 'text/css; charset=utf-8';
  // 'x.js'/'x.mjs' → 'text/javascript; charset=utf-8'; 'x.md' → 'text/markdown; charset=utf-8'; 'x.svg' → 'image/svg+xml';
  // 'x.mp4' → 'video/mp4'; 'x.webm' → 'video/webm'; 'x.woff2' → 'font/woff2'; 'x.jpg' → 'image/jpeg'; 'noext' → 'application/octet-stream'
test('classifies text and raster types', ...);     // isTextType: html, css, js, json, md, svg true; png false. isRasterImage: png, jpeg, webp, gif, avif true; svg false
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/publish/paths test/publish/limits test/content/mime`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** `normalizeEntryPath` applies these rules in order:
  1. Strip every leading `./` and NFC-normalize. `''`, `.`, or a trailing `/` → `{ skip: 'directory' }`.
  2. Check the characters: a C0 control character or DEL → `control`; `\` → `backslash`; a leading `/` or `/^[A-Za-z]:/` → `absolute`.
  3. Split on `/`. An empty segment → `empty_segment`; `.` or `..` → `dot_segment`; first segment `__pinwall` → `reserved`.
  4. Junk → `{ skip: 'junk' }`: first segment `__MACOSX`, a basename starting with `._`, or a basename `.DS_Store`.
  5. More than 512 code points → `too_long`.

  `chooseEntry` looks for `index.html`, then `index.md`, then `README.md` (all at the root), then the only file. Kind is `markdown` when the entry ends in `.md`. Callers detect duplicates with a `Set` of normalized paths and `rejectPath(p, 'duplicate')`. MIME: one lookup table covering the extensions in the test plus `htm, json, map, txt, csv, xml, ico, bmp, woff, ttf, otf, ogg, ogv, mp3, wav, m4a, pdf, wasm`. Text types get `; charset=utf-8`.
  en.json:
  - `"publish.path.absolute": "{{path}}: absolute paths are not allowed. Archive the folder's contents with relative paths."`
  - `"publish.path.dot_segment": "{{path}}: path segments \".\" and \"..\" are not allowed."`
  - `"publish.path.backslash": "{{path}}: use forward slashes in paths, not backslashes."`
  - `"publish.path.control": "{{path}}: paths cannot contain control characters."`
  - `"publish.path.empty_segment": "{{path}}: paths cannot contain empty segments (\"//\")."`
  - `"publish.path.too_long": "{{path}}: paths can be at most {{max}} characters long."`
  - `"publish.path.duplicate": "{{path}} appears more than once. Names that differ only in Unicode normalization count as the same name."`
  - `"publish.path.reserved": "{{path}}: the folder __pinwall/ is reserved for Pinwall."`
  - `"publish.path.link": "{{path}} is a symbolic or hard link, and links are not allowed. Archive the file itself (tar -h follows symlinks)."`
  - `"publish.path.special": "{{path}} is a device, FIFO or other special file. Only regular files and folders are allowed."`
  - `"publish.entry.empty": "The upload contains no files."`
  - `"publish.entry.none": "No entry page found. Name the main page index.html or index.md."`
  - `"publish.limit.max_upload_bytes": "The upload is larger than the limit of {{max}} bytes (PINWALL_MAX_UPLOAD_BYTES)."`
  - `"publish.limit.max_file_bytes": "{{path}} is larger than the per-file limit of {{max}} bytes (PINWALL_MAX_FILE_BYTES)."`
  - `"publish.limit.max_version_bytes": "The files add up to more than {{max}} bytes (PINWALL_MAX_VERSION_BYTES)."`
  - `"publish.limit.max_files": "The upload has more than {{max}} files (PINWALL_MAX_FILES)."`
  - `"publish.limit.max_expansion_ratio": "The archive expands to more than {{max}} times its compressed size (PINWALL_MAX_EXPANSION_RATIO), so it looks like an archive bomb."`
  - `"publish.limit.max_inline_bytes": "The inline files add up to more than {{max}} bytes (PINWALL_MAX_INLINE_BYTES). Use an upload URL instead."`
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add upload path rules, ingest limits and MIME types`.

### Task 2: Archive readers — tar, tar.gz, zip (model: opus)

**Files:**
- Create: `apps/server/src/publish/{archive.ts,zip.ts}`, `apps/server/test/helpers/archives.ts`
- Modify: `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/publish/archive.test.ts`

**Interfaces:**
- Consumes: Task 1 `IngestBudget`, `rejectPath`; M1 `badRequest`, `unsupportedMediaType`.
- Produces:

```ts
// publish/archive.ts
export type ArchiveFormat = 'tar' | 'tar.gz' | 'zip';
export function sniffArchive(head: Buffer): ArchiveFormat | null;   // 1f 8b → tar.gz; 'PK\x03\x04' | 'PK\x05\x06' → zip; 'ustar' at offset 257 → tar
export type EntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
export interface ArchiveEntry { rawPath: string; type: EntryType; size: number | null; body: Readable }   // body is empty unless type 'file'
export function readArchive(input: Readable, format: ArchiveFormat, budget: IngestBudget,
  onEntry: (e: ArchiveEntry) => Promise<void>): Promise<void>;   // calls onEntry one entry at a time; onEntry must consume or resume body
export function corruptArchive(): AppError;   // badRequest(t('publish.archive.corrupt'), { reason: 'corrupt_archive' })
// publish/zip.ts
export interface ZipEntryInfo { name: string; type: EntryType; method: number; compressedSize: number; size: number; crc32: number; localHeaderOffset: number; encrypted: boolean }
export function readZipDirectory(zip: Buffer): ZipEntryInfo[];
// test/helpers/archives.ts
export interface TarSpec { name: string; body?: string | Buffer; type?: 'file' | 'directory' | 'symlink' | 'link' | 'character-device'; linkname?: string }
export function makeTar(entries: TarSpec[], o?: { gzip?: boolean }): Promise<Buffer>;    // tar-stream pack (+ zlib gzip)
export interface ZipSpec { name: string; body?: string | Buffer; mode?: number; level?: 0 | 6 }   // mode → fflate { os: 3, attrs: mode << 16 }
export function makeZip(entries: ZipSpec[]): Buffer;                                        // fflate zipSync
```

- [ ] **Step 1: Write the failing tests.** `collect(buf, format, budget?)` runs `readArchive(Readable.from(buf), …)` and returns `{ rawPath, type, size, text }[]`. The default budget is roomy.

```ts
test('sniffs formats by magic bytes', async () => {
  expect(sniffArchive(await makeTar([{ name: 'a', body: 'x' }], { gzip: true }))).toBe('tar.gz');
  expect(sniffArchive(await makeTar([{ name: 'a', body: 'x' }]))).toBe('tar');
  expect(sniffArchive(makeZip([{ name: 'a', body: 'x' }]))).toBe('zip');
  expect(sniffArchive(Buffer.from('<!doctype html>'))).toBeNull();
});
test('reads tar and tar.gz entries with their types', async () => {
  const tgz = await makeTar([{ name: './', type: 'directory' }, { name: './index.html', body: '<h1>x</h1>' },
    { name: './l', type: 'symlink', linkname: '/etc/passwd' }, { name: './h', type: 'link', linkname: './index.html' },
    { name: './dev', type: 'character-device' }], { gzip: true });
  expect(await collect(tgz, 'tar.gz')).toEqual([
    { rawPath: './', type: 'directory', size: 0, text: '' }, { rawPath: './index.html', type: 'file', size: 10, text: '<h1>x</h1>' },
    { rawPath: './l', type: 'symlink', size: 0, text: '' }, { rawPath: './h', type: 'hardlink', size: 0, text: '' },
    { rawPath: './dev', type: 'other', size: 0, text: '' }]);
});
test('reads long names from pax headers', ...);          // a 300-character path survives intact
test('reads zip entries with unix types', ...);          // file 'a.txt'; dir 'd/'; mode 0o120777 'l' → symlink; mode 0o020644 → other
test('stored and deflated zip entries round-trip', ...); // level 0 and level 6, 200 KB of random bytes → identical
test('a corrupt archive is bad_request corrupt_archive', ...);
  // tar.gz cut in half; a zip with one CRC byte flipped; 1f 8b followed by random bytes → 400 { reason: 'corrupt_archive' }
test('an expansion bomb stops early', async () => {
  const budget = new IngestBudget({ ...roomy, maxExpansionRatio: 100 });
  const tgz = await makeTar([{ name: 'z.bin', body: Buffer.alloc(10_000_000) }], { gzip: true });
  budget.onRequestBytes(tgz.length);   // ingest counts request bytes upstream; do the same here
  let read = 0;
  await expect(readArchive(Readable.from(tgz), 'tar.gz', budget, async (e) => { for await (const c of e.body) read += c.length; }))
    .rejects.toMatchObject({ status: 413, details: { limit: 'max_expansion_ratio', max: 100 } });
  expect(read).toBeLessThan(10_000_000);
});                                                       // the same for a deflated zip of 10 MB of zeros
test('errors thrown by onEntry propagate unchanged', ...);   // onEntry throws rejectPath('x', 'link') → that exact AppError
test('zip64 is refused with a hint', ...);   // a zip whose EOCD entry count is patched to 0xffff → 415 unsupported_media_type, t('publish.archive.zip64')
test('encrypted zip entries are refused', ...);   // general-purpose flag bit 0 patched in the central directory → 400 { reason: 'encrypted' }
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/publish/archive`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **tar / tar.gz.** Use tar-stream `extract()`, behind `zlib.createGunzip()` for tar.gz. Count gunzip output with `budget.onExpandedBytes` in a pass-through `Transform`. Types: `file` and `contiguous-file` → `file`; `directory`; `symlink`; `link` → `hardlink`; any other type → `other`. Call `next()` only after `onEntry` resolves and the entry stream has ended. An error from onEntry or the budget destroys the pipeline and rejects with that error. A gunzip or tar-stream error, or an early end of input, rejects with `corruptArchive()`.
  - **zip.** Collect the input into one Buffer. Its size is already bounded by the request limit, which ingest counts before this point. fflate does not expose external attributes, so the central directory drives extraction. `readZipDirectory` works as follows:
    1. Find the EOCD signature `0x06054b50` by scanning backwards over the last 65,557 bytes. An entry count of `0xffff`, or a size or offset of `0xffffffff`, → `unsupportedMediaType(t('publish.archive.zip64'))`.
    2. Walk the `0x02014b50` records: version made by at +4, flags at +8, method at +10, CRC at +16, compressed size at +20, size at +24, name length at +28, extra length at +30, comment length at +32, external attributes at +38, local header offset at +42, name at +46.
    3. Decode names as UTF-8 (fatal), falling back to latin1.
    4. Type: a name ending in `/` → `directory`. If the high byte of version-made-by is 3 (Unix), mode = attrs >>> 16, and `mode & 0o170000` is `0o120000` → `symlink`, `0o040000` → `directory`, `0o100000` or 0 → `file`, anything else → `other`.

    Each entry's data starts at `localHeaderOffset + 30 + nameLen + extraLen`, reading both lengths from the local header (`0x04034b50`). Method 0 is a slice; method 8 goes through fflate `Inflate` fed 64 KiB at a time, every output chunk counted with `budget.onExpandedBytes`. Any other method → `badRequest(t('publish.archive.zipMethod', { path }), { reason: 'zip_method', path })`. An encrypted entry → `badRequest(t('publish.archive.encrypted', { path }), { reason: 'encrypted', path })`. An inflated length or `zlib.crc32` that differs from the directory → `corruptArchive()`. Bodies are `Readable.from` generators.
  - en.json:
    - `"publish.archive.corrupt": "The archive is damaged or truncated and could not be read."`
    - `"publish.archive.zip64": "ZIP64 archives are not supported. Send a tar.gz instead: tar -czf - -C <folder> ."`
    - `"publish.archive.zipMethod": "{{path}} uses a ZIP compression method other than store or deflate."`
    - `"publish.archive.encrypted": "{{path}} is encrypted, and encrypted archives are not supported."`
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): read tar, tar.gz and zip archives with entry types and expansion limits`.

### Task 3: Migration 0002, tombstones, blob staging and blob GC (model: opus)

**Files:**
- Create: `apps/server/src/db/migrations/0002_publishing.ts`, `apps/server/src/domain/{tombstones.ts,blobs.ts}`, `apps/server/src/publish/stage.ts`
- Modify: `apps/server/src/db/migrations/index.ts` (one entry), `apps/server/src/db/schema.ts` (add `TombstonesTable`, `TombstoneRow`), `apps/server/test/db/migrate.test.ts` (expect `['0001_initial', '0002_publishing']`, add `tombstones` to the table list)
- Test: `apps/server/test/domain/{tombstones,blobs}.test.ts`, `apps/server/test/publish/stage.test.ts`

**Interfaces:**
- Consumes: M1 `AppDeps` (`db`, `blobs`, `leases`, `clock`), `bigintCol`, `MigrationDb`; M2 `Db`; Task 1 `IngestBudget`, `contentTypeFor`.
- Produces:

```ts
// migration 0002_publishing
//   create table tombstones (kind text not null, key text not null, deleted_at bigint not null, expires_at bigint null, primary key (kind, key))
//   + index tombstones_expires_at_idx; + index version_files_sha256_idx on version_files (sha256)   (blob GC asks "is this sha still referenced?")
// db/schema.ts
export type TombstoneKind = 'artifact' | 'content_grant' | 'share_link';   // keys: artifact id | grant token | share token_hash
export interface TombstonesTable { kind: Fixed<TombstoneKind>; key: Fixed<string>; deleted_at: number; expires_at: number | null }
// domain/tombstones.ts
export function addTombstones(db: Db, rows: { kind: TombstoneKind; key: string; expiresAt: number | null }[], now: number): Promise<void>;  // on conflict do nothing; chunks of 500
export function isTombstoned(db: Db, kind: TombstoneKind, key: string): Promise<boolean>;   // expired rows count as absent
export function pruneTombstones(deps: AppDeps): Promise<number>;                             // deletes expires_at <= now
// domain/blobs.ts
export const BACKUP_LEASE = 'maintenance:backup';   // M9's backup holds it
export interface BlobRegistry {            // in-process now; a multi-instance build swaps in a shared implementation
  withLock<T>(sha256: string, fn: () => Promise<T>): Promise<T>;   // serializes staging and collection per sha
  pin(owner: string, sha256: string): void;
  unpinAll(owner: string): string[];       // the shas this owner had pinned
  isPinned(sha256: string): boolean;
}
export class InProcessBlobRegistry implements BlobRegistry {}
export function blobRegistry(deps: AppDeps): BlobRegistry;   // one per AppDeps (WeakMap), so AppDeps keeps its roadmap shape
export function collectBlobs(deps: AppDeps, sha256s: Iterable<string>): Promise<{ deleted: string[]; deferred: string[] }>;
export function sweepBlobs(deps: AppDeps, batch?: number): Promise<number>;   // default batch 500
// publish/stage.ts
export interface StagedFile { path: string; sha256: string; size: number; contentType: string }
export class BlobStager {
  constructor(deps: AppDeps, budget: IngestBudget);   // owner id = newSecret()
  readonly files: StagedFile[];
  stage(path: string, body: Readable | Buffer, declaredSize: number | null): Promise<StagedFile>;
  abort(): Promise<void>;     // unpinAll, then collectBlobs of what it pinned
  release(): void;            // unpinAll after the version row is committed
}
```

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `sha('x')` is the hex SHA-256; `ref(sha)` inserts a project, artifact, version and a `version_files` row pointing at `sha`):

```ts
test('tombstones answer and prune', ...);   // add artifact 'art_1' (expiresAt null) and content_grant 'tok' (now + 1000) → both true;
  // advance 1001 → isTombstoned('content_grant', 'tok') false; pruneTombstones → 1; artifact still true
test('staging stores each blob once and records its row', ...);
  // stage 'a.txt' and 'b.txt', both 'hello' → one blobs row { sha256: sha('hello'), size: 5 }; blobs.has true; files[0].contentType 'text/plain; charset=utf-8'
test('staging counts bytes against the budget', ...);   // maxFileBytes 4: stage 'hello' → 413 max_file_bytes; nothing stored
test('abort removes blobs this upload added and keeps referenced ones', ...);
  // ref(sha('A')); stage 'A' and 'B'; abort → blob and row of B gone; A kept
test('a blob pinned by another upload survives collection', ...);
  // s1 and s2 both stage 'X'; s1.abort → X kept; s2.abort → X gone (row and object)
test('collection defers while the backup lease is held', async () => {
  // a blobs row + object for 'Y' with no reference; leases.acquire(BACKUP_LEASE, 'backup', 60_000)
  expect(await collectBlobs(ctx.deps, [sha('Y')])).toEqual({ deleted: [], deferred: [sha('Y')] });
  expect(await sweepBlobs(ctx.deps)).toBe(0);              // still held
  await ctx.deps.leases.release(BACKUP_LEASE, 'backup');
  expect(await sweepBlobs(ctx.deps)).toBe(1);
  expect(await ctx.deps.blobs.has(sha('Y'))).toBe(false);
});
test('sweep removes unreferenced rows left by a crash and keeps the rest', ...);   // orphan row+object gone; ref'd kept; pinned kept
test('migration 0002 adds tombstones and the sha256 index', ...);   // tombstones queryable; index version_files_sha256_idx exists
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/domain/tombstones test/domain/blobs test/publish/stage test/db/migrate`. Expected: FAIL.
- [ ] **Step 3: Implement.** The ordering below keeps a blob from being deleted while an upload or a committed version needs it.
  - **`stage`:** `budget.startFile(path, declaredSize)`. Read the body into one Buffer, calling `budget.onFileBytes` per chunk. Hash it. Then, under `withLock(sha)`: pin the sha for this owner, insert the `blobs` row (`on conflict do nothing`), and `blobs.put(sha, buf, size)`. `put` is a no-op when the blob already exists. Push `{ path, sha256, size, contentType: contentTypeFor(path) }`.
  - **`collectBlobs`:** for each sha, under `withLock(sha)`:
    1. Skip it when pinned or referenced by `version_files`.
    2. Defer it when `leases.isHeld(BACKUP_LEASE)` (the row stays, so the sweep finds it later).
    3. Otherwise delete the `blobs` row, then `blobs.delete(sha)`.
  - **`sweepBlobs`:** returns 0 while the lease is held. Otherwise it selects up to `batch` `blobs` rows with no `version_files` reference (`not exists`, served by the new index) and collects them.
- [ ] **Step 4: Run** the Step 2 command, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS on both.
- [ ] **Step 5: Commit** `feat(server): add tombstones, blob staging and lease-aware blob garbage collection`.

### Task 4: Metadata and search text extraction (model: sonnet)

**Files:**
- Create: `apps/server/src/content/metadata.ts`
- Modify: `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/content/metadata.test.ts`

**Interfaces:**
- Consumes: Task 1 `contentTypeFor`, `isRasterImage`; M1 `AppDeps`, `ArtifactKind`, `t`; markdown-it (parse only), htmlparser2 `Parser`.
- Produces:

```ts
export const SEARCH_TEXT_MAX_CHARS = 200_000;
export const MAX_WARNINGS = 50;
export const SCAN_MAX_BYTES = 5_000_000;   // per HTML/CSS file scanned for warnings
export interface PublishWarning { code: 'root_absolute_url'; file: string; url: string; message: string }
export interface VersionMetadata { title: string | null; themeColor: string | null; thumbnailPath: string | null; text: string; warnings: PublishWarning[] }
export interface MetadataFile { path: string; contentType: string; size: number; read(): Promise<Buffer> }
export function extractMetadata(files: readonly MetadataFile[], entryPath: string, kind: ArtifactKind): Promise<VersionMetadata>;
export function extractVersionText(deps: AppDeps, versionId: string): Promise<string>;   // the same text rule over stored files
export function resolveRef(fromFile: string, ref: string): string | null;
  // relative URL → version path (query and fragment dropped, percent-decoded, NFC); null for absolute URLs, '//', '/x', data:, '#…', or escaping the root
```

- [ ] **Step 1: Write the failing tests.** `files({...})` builds `MetadataFile`s from a path → string record.

```ts
test('title from <title>, else the first heading', ...);   // '<title> Bảng  giá </title>' → 'Bảng giá'; no title, '<h2>Hi <b>there</b></h2>' → 'Hi there'; neither → null
test('markdown title from the first heading', ...);       // 'intro\n\n## Báo cáo *quý*\n' → 'Báo cáo quý'
test('titles are capped at 200 characters', ...);
test('theme color is kept only when it looks like a color', ...);
  // content '#0ea5e9' → '#0ea5e9'; 'rebeccapurple' kept; 'rgb(1, 2, 3)' kept; 'red;background:url(x)' → null; markdown → null
test('thumbnail from og:image, then the first image, raster only', ...);
  // og:image 'img/cover.png' (present) → 'img/cover.png'; og:image 'https://cdn.example/x.png' and <img src="a%20b.jpg"> with 'a b.jpg' present → 'a b.jpg';
  // only <img src="logo.svg"> → null; og:image naming a missing file → falls through to <img>
test('thumbnail paths resolve relative to the entry', ...);  // entry 'docs/index.html', <img src="../img/x.webp"> → 'img/x.webp'; '../../x.png' → null
test('markdown thumbnail is the first image', ...);          // '![a](pics/one.png)' → 'pics/one.png'
test('search text skips scripts and styles, spans pages and is capped', ...);
  // entry '<p>Dịch vụ chụp ảnh</p><script>var secret=1</script><style>.x{}</style>', 'b.md' '# Giá' → text contains 'chụp ảnh' and 'Giá', not 'secret' or '.x{';
  // entry text first; 300_000 chars of words → text.length === 200_000
test('root-absolute URLs are warned about once per file and URL', async () => {
  const m = await extractMetadata(files({ 'index.html': '<link href="/x.css"><img src="/x.css"><a href="//cdn.example/x"><img srcset="/a.png 1x, b.png 2x">',
    'style.css': 'body{background:url(/bg.png)} @import "/base.css";' }), 'index.html', 'html');
  expect(m.warnings.map(w => [w.file, w.url])).toEqual([['index.html', '/x.css'], ['index.html', '/a.png'], ['style.css', '/bg.png'], ['style.css', '/base.css']]);
  expect(m.warnings[0]?.message).toBe(t('publish.warning.rootAbsolute', { file: 'index.html', url: '/x.css' }));
});
test('at most 50 warnings', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/content/metadata`. Expected: FAIL.
- [ ] **Step 3: Implement.** HTML goes through an htmlparser2 `Parser` with callbacks, no DOM.
  - **Title and theme color** come from the entry only. The first `<meta name="theme-color">` must match `/^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\))$/i` and be ≤ 64 characters.
  - **`og:image`:** `<meta property="og:image">` or `name="og:image"`.
  - **Text** is taken from text nodes outside `script`, `style` and `template`. For Markdown, take the `text`, `code_inline` and `fence` content of markdown-it tokens. Use the entry first, then the other `.html`/`.htm`/`.md` files by path. Collapse whitespace and stop at `SEARCH_TEXT_MAX_CHARS`.
  - **Warnings** come from every `.html`/`.htm` file (attributes `href src action poster data formaction srcset`, plus `<style>` content) and every `.css` file (`url(…)`, `@import`), each read up to `SCAN_MAX_BYTES`. A value warns when it starts with `/` but not `//`.
  - en.json: `"publish.warning.rootAbsolute": "{{file}} refers to {{url}} from the server root, which does not load in single-domain mode. Use a relative path."`
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): extract title, theme color, thumbnail, search text and root-absolute URL warnings`.

### Task 5: Projects, version commit, restore and search reindexing (model: opus)

**Files:**
- Create: `apps/server/src/domain/{projects.ts,artifacts.ts,versions.ts,search.ts}`
- Modify: `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/domain/{projects,commit}.test.ts`, `apps/server/test/helpers/staged.ts`

**Interfaces:**
- Consumes: M1 `searchUpsert`, `searchDelete`, `searchQuery`, `newId`, `notFound`, `gone`, `conflict`, `AppError`, row types; M2 `Db`, `createSignedInUser`; Task 3 `StagedFile`, `BlobStager`, `isTombstoned`; Task 4 `VersionMetadata`, `extractVersionText`.
- Produces:

```ts
// domain/projects.ts
export const DEFAULT_PROJECT_ID = 'prj_00000000000000000000';
export function ensureDefaultProject(deps: AppDeps): Promise<ProjectRow>;   // insert … on conflict (id) do nothing; name t('project.defaultName'), instructions ''
export function getProject(db: Db, id: string): Promise<ProjectRow>;       // notFound(t('project.notFound'))
export function createProject(deps: AppDeps, actor: UserRow, p: { name: string; instructions?: string }): Promise<ProjectRow>;
export function updateProject(deps: AppDeps, id: string, p: { name?: string; instructions?: string; archived?: boolean }): Promise<ProjectRow>;
  // archiving the default project → conflict(t('project.defaultArchive'))
// domain/artifacts.ts
export function getArtifact(db: Db, id: string): Promise<ArtifactRow>;     // gone(t('artifact.gone')) when tombstoned, else notFound(t('artifact.notFound'))
export function lockArtifact(trx: Transaction<Database>, dialect: DbDialect, id: string): Promise<ArtifactRow | undefined>;   // pg: FOR UPDATE
export function normalizeTags(tags: readonly string[]): string[];
  // NFC, trim, collapse spaces, lowercase, dedupe, sorted; each 1..40 chars, at most 20 → else badRequest(t('artifact.badTags'), { field: 'tags' })
export function getTags(db: Db, artifactId: string): Promise<string[]>;
// domain/versions.ts
export type PublishTarget =
  | { kind: 'new_artifact'; projectId: string | null; name: string | null; tags: string[] }
  | { kind: 'new_version'; artifactId: string; expectedVersionId: string };
export interface VersionInput { entryPath: string; kind: ArtifactKind; files: readonly StagedFile[]; meta: VersionMetadata;
  message: string | null; source: VersionSource }
export interface CommitResult { artifact: ArtifactRow; version: VersionRow }
export function versionConflict(current: { id: string; number: number }): AppError;
  // AppError('version_conflict', 409, t('publish.versionConflict', { number }), { current_version_id, current_version_number })
export function checkTarget(deps: AppDeps, target: PublishTarget): Promise<void>;   // the commit's checks, without writing
export function commitVersion(deps: AppDeps, actor: UserRow, target: PublishTarget, input: VersionInput): Promise<CommitResult>;
export function getVersionByNumber(db: Db, artifact: ArtifactRow, n: number): Promise<VersionRow>;
  // missing: n <= latest_number → gone(t('version.gone')), else notFound(t('version.notFound'))
export function restoreVersion(deps: AppDeps, actor: UserRow, artifactId: string, n: number, expectedVersionId: string): Promise<CommitResult>;
// domain/search.ts
export function indexArtifact(scope: DbScope, artifact: ArtifactRow, tags: string[], text: string): Promise<void>;   // searchUpsert(name, tags.join(' '), text)
export function reindexArtifact(deps: AppDeps, artifactId: string): Promise<void>;   // text from extractVersionText(current); no current → searchDelete
export const ARTIFACT_TOPIC = (artifactId: string) => `artifact:${artifactId}`;      // M5 subscribes
// test/helpers/staged.ts
export function stageFiles(ctx: TestContext, files: Record<string, string | Buffer>): Promise<StagedFile[]>;
export function emptyMeta(over?: Partial<VersionMetadata>): VersionMetadata;
```

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `actor` from `createSignedInUser`; `commit(target, files, meta?)` wraps `commitVersion` with entry `index.html`, kind `html`, source `api`):

```ts
test('the default project exists exactly once', ...);   // Promise.all of 3 ensureDefaultProject → one row { id: DEFAULT_PROJECT_ID, is_default: 1, name: 'Default' }
test('the default project cannot be archived', ...);    // updateProject(DEFAULT_PROJECT_ID, { archived: true }) → 409 conflict; renaming works
test('a first publish creates v1 in the default project', ...);
  // commit({ kind: 'new_artifact', projectId: null, name: null, tags: [' Đồ Án ', 'đồ án'] }, { 'index.html': '<h1>x</h1>' }) →
  // artifact { project_id: DEFAULT_PROJECT_ID, current_version_id: version.id, latest_number: 1, kind: 'html' };
  // version { number: 1, parent_version_id: null, file_count: 1, total_bytes: 10, source: 'api', meta: '{"warnings":[]}' }; tags ['đồ án']
test('a new version needs the current version id', ...);
  // v2 with expectedVersionId v1.id → number 2, parent v1.id; again with v1.id → AppError { code: 'version_conflict', status: 409,
  //   details: { current_version_id: v2.id, current_version_number: 2 } }, message contains 'v2'
test('two concurrent publishes on one version: exactly one wins', ...);   // Promise.allSettled → 1 fulfilled, 1 version_conflict; latest_number 2
test('names default to the title, then the entry file name', ...);
  // meta.title 'Báo cáo' → 'Báo cáo'; no title, entry 'docs/guide.md' → 'guide'; explicit name wins
test('an archived or unknown project refuses new artifacts', ...);   // archived → 409 conflict t('project.archived'); 'prj_nope' → 404
test('checkTarget validates without writing', ...);   // stale expected → version_conflict; artifacts count unchanged
test('publishing indexes search in the same transaction and emits version.published', ...);
  // meta.text 'Dịch vụ chụp ảnh' → searchQuery('chup anh') → [artifact.id];
  // subscriber on ARTIFACT_TOPIC(id) receives { type: 'version.published', artifact_id, version_id, number: 1 }
test('restore copies an old version into a new one', ...);
  // v1 { 'index.html': 'one' }, v2 { 'index.html': 'two' }; restore(1, expected v2.id) → v3 with v1's sha, source 'restore',
  // restored_from_version_id v1.id, parent v2.id, message 'Restored from v1'; blobs row count unchanged; stale expected → version_conflict
test('a missing version number is gone or not found', ...);   // delete v1's row directly → getVersionByNumber(1) gone 410; (5) → 404
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/domain/projects test/domain/commit`. Expected: FAIL.
- [ ] **Step 3: Implement `commitVersion`.** These steps are the algorithm:
  1. For `new_artifact`, take `projectId ?? (await ensureDefaultProject(deps)).id`. The project must exist and not be archived. The name is `target.name ?? meta.title ??` the entry's basename without its extension `?? t('artifact.untitled')`, cut to 200 characters.
  2. Open one transaction. For `new_version`: `lockArtifact`; missing → `getArtifact` semantics; if `current_version_id !== expectedVersionId`, throw `versionConflict` (its number comes from the current version's row). `number = latest_number + 1`.
  3. Insert the artifact if it is new (`newId('art')`, `latest_number` 0) and its tags.
  4. Insert the version (`newId('ver')`, `parent_version_id` = the previous current, `meta` = `JSON.stringify({ warnings })`), then the `version_files` rows in chunks of 500.
  5. Update the artifact: `current_version_id`, `latest_number = number`, `kind = input.kind`, `updated_at`.
  6. `indexArtifact({ db: trx, dialect }, …, meta.text)`.
  7. After commit, `deps.events.publish(ARTIFACT_TOPIC(id), { type: 'version.published', artifact_id, version_id, number })`.

  `restoreVersion` follows the same steps. Its files are copied with `insert … select` from the old version's rows, its title, theme color, thumbnail and meta come from the old row, and its text comes from `extractVersionText(old)` read before the transaction. `checkTarget` runs steps 1–2 read-only.
  en.json:
  - `"project.defaultName": "Default"`
  - `"project.notFound": "This project does not exist."`
  - `"project.archived": "This project is archived. Unarchive it or publish to another project."`
  - `"project.defaultArchive": "The default project cannot be archived."`
  - `"artifact.notFound": "This artifact does not exist."`
  - `"artifact.gone": "This artifact was deleted."`
  - `"artifact.untitled": "Untitled"`
  - `"artifact.badTags": "Use at most 20 tags of 1 to 40 characters each."`
  - `"version.notFound": "This version does not exist."`
  - `"version.gone": "This version was deleted."`
  - `"version.restoredFrom": "Restored from v{{number}}"`
  - `"publish.versionConflict": "The artifact has a newer version (v{{number}}) than the one this publish replaces. Fetch the artifact again and publish on top of v{{number}}."`
- [ ] **Step 4: Run** the Step 2 command, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS on both.
- [ ] **Step 5: Commit** `feat(server): add projects, version commit with optimistic concurrency, restore and search indexing`.

### Task 6: Ingest pipeline — uploads, file sets, inline (model: opus)

**Files:**
- Create: `apps/server/src/publish/ingest.ts`, `apps/server/test/helpers/publish.ts`
- Modify: `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/publish/ingest.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`normalizeEntryPath`, `rejectPath`, `stripWrapperFolder`, `chooseEntry`, `IngestBudget`, `limitExceeded`, `isTextType`, `contentTypeFor`, `sniffArchive`, `readArchive`, `BlobStager`, `extractMetadata`, `checkTarget`, `commitVersion`, `PublishTarget`, `makeTar`, `makeZip`); M1 `publicUrl`, `unsupportedMediaType`.
- Produces:

```ts
export interface PublishOptions { actor: UserRow; source: VersionSource; message: string | null }
export interface PublishOutcome { artifact: ArtifactRow; version: VersionRow; warnings: PublishWarning[] }
export interface UploadInput { body: Readable; contentType: string | null; contentLength: number | null; filename: string | null }
export function ingestUpload(deps: AppDeps, target: PublishTarget, input: UploadInput, opts: PublishOptions): Promise<PublishOutcome>;
export function ingestFiles(deps: AppDeps, target: PublishTarget, files: readonly { path: string; data: Buffer }[], opts: PublishOptions): Promise<PublishOutcome>;
export interface InlineFile { path: string; content: string }
export function ingestInline(deps: AppDeps, target: PublishTarget, files: readonly InlineFile[], opts: PublishOptions): Promise<PublishOutcome>;
export function publishLinks(config: Config, artifactId: string, n: number): { review_url: string; raw_url: string };
  // publicUrl('/a/<id>'), publicUrl('/a/<id>/v/<n>/raw')
// test/helpers/publish.ts — used by every later task
export function publishFiles(ctx: TestContext, actor: UserRow, files: Record<string, string | Buffer>,
  target?: PublishTarget): Promise<PublishOutcome>;   // ingestFiles, source 'api', default target new artifact in the default project
```

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `upload(buf, o?)` = `ingestUpload(ctx.deps, newTarget, { body: Readable.from(buf), contentType: o?.type ?? null, contentLength: null, filename: o?.filename ?? null }, opts)`; `paths(v)` = sorted `version_files` paths):

```ts
test('publishes a tar.gz made with tar -C dir .', ...);   // './', './index.html', './css/a.css' → paths ['css/a.css', 'index.html'], entry 'index.html', kind html, file_count 2
test('publishes a zip', ...);
test('macOS junk is skipped and a wrapping folder stripped', async () => {   // Review Focus 4
  const tgz = await makeTar([{ name: 'site/', type: 'directory' }, { name: 'site/index.html', body: '<title>Hi</title>' },
    { name: 'site/._index.html', body: 'x' }, { name: '__MACOSX/site/._index.html', body: 'x' }, { name: 'site/.DS_Store', body: 'x' },
    { name: 'site/img/a.png', body: 'png' }], { gzip: true });
  const { version } = await upload(tgz);
  expect(await paths(version)).toEqual(['img/a.png', 'index.html']);
  expect(version).toMatchObject({ entry_path: 'index.html', title: 'Hi' });
});
test('NFD names are stored in NFC', ...);   // Review Focus 1: tar entry 'Tài liệu.html'.normalize('NFD') → path 'Tài liệu.html' (NFC), entry it
test('single files by content type or filename', ...);
  // type 'text/html; charset=utf-8' → ['index.html'] html; 'text/markdown' → ['index.md'] markdown;
  // type 'application/pdf', filename 'docs/report.pdf' → ['docs/report.pdf'], entry it;
  // 'application/octet-stream', no filename, bytes '%PDF-1.7' → 415 unsupported_media_type t('publish.unsupported')
test("curl's default content type is ignored for archives", ...);   // Review Focus 5: type 'application/x-www-form-urlencoded' + tar.gz → publishes
test.each(REJECTIONS)('a rejected upload leaves no version and no orphan blobs: %s', async (_name, build, expected) => {   // Review Focus 3
  // ctx env: PINWALL_MAX_FILE_BYTES=1000, PINWALL_MAX_FILES=3, PINWALL_MAX_VERSION_BYTES=2500, PINWALL_MAX_UPLOAD_BYTES=20000
  // every archive starts with a good 'a.css' entry, so a blob exists before the bad entry arrives
  await expect(upload(await build())).rejects.toMatchObject(expected);
  for (const t of ['artifacts', 'versions', 'version_files', 'blobs'] as const)
    expect(await ctx.deps.db.db.selectFrom(t).selectAll().execute()).toEqual([]);
  expect(await Array.fromAsync(ctx.deps.blobs.list())).toEqual([]);
});
// REJECTIONS: '../evil' → { status: 400, details: { reason: 'dot_segment' } }; '/abs' → absolute; symlink → link; hardlink → link;
//   character device → special; 'é.html' NFC and NFD → duplicate; '__pinwall/x.js' → reserved; 1001-byte file → 413 max_file_bytes;
//   4 files → max_files; 3 × 900 bytes → max_version_bytes; 40 skipped `._pad` entries of 900 bytes (61 KB of tar) → max_upload_bytes;
//   a skipped `._bomb` entry of 10 MB of zeros, gzipped (≈ 10 KB) → max_expansion_ratio (skipped entries still expand);
//   'a.html' + 'b.html' → 400 no_entry; a truncated tar.gz → corrupt_archive
test('a rejected upload keeps blobs other versions use', ...);   // publishFiles({ 'a.css': 'x', 'index.html': '1' }); a failing upload with the same a.css → that blob kept
test('a version_conflict is found before the body is read', ...);   // stale expectedVersionId → 409; a counting body stream saw 0 bytes read
test('ingestFiles publishes a dropped folder', ...);   // [{ path: 'site/index.html' }, { path: 'site/app.js' }] → ['app.js', 'index.html']
test('inline publish takes text files within the inline limit', ...);
  // env PINWALL_MAX_INLINE_BYTES=100: [{ path: 'index.html', content: '<h1>chụp ảnh</h1>' }] → ok, source 'inline';
  // [{ path: 'a.png', content: 'x' }] → 400 { reason: 'inline_text_only', path: 'a.png' };
  // 34 × 'ả' (3 UTF-8 bytes each = 102) → 413 { limit: 'max_inline_bytes', max: 100 }
test('warnings come back with the outcome', ...);   // '<link href="/x.css">' → warnings[0].url '/x.css'
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/publish/ingest`. Expected: FAIL.
- [ ] **Step 3: Implement.** `ingestUpload`, in this order:
  1. `checkTarget`, before any byte is read.
  2. A `contentLength` above `maxUploadBytes` → `limitExceeded('max_upload_bytes', …)`.
  3. Pipe the body through a counting `Transform` → `budget.onRequestBytes`.
  4. Pick the mode:
     - With a `filename`, stage one file at `normalizeEntryPath(filename)`. A name that would be skipped → `publish.entry.empty`.
     - Else, a media type (before `;`, lowercased) of `text/html` stages `index.html`, and `text/markdown` or `text/x-markdown` stages `index.md`.
     - Else, peek the first 512 bytes (unshift them back), `sniffArchive` → `readArchive`. `null` → `unsupportedMediaType(t('publish.unsupported'))`.
  5. For each entry: `normalizeEntryPath`. A skip → `body.resume()` and wait for its end. `symlink`/`hardlink` → `rejectPath(raw, 'link')`, `other` → `'special'`. Duplicate normalized paths → `'duplicate'`. Then `stager.stage(path, body, size)`.
  6. `stripWrapperFolder` and rename the staged paths. `chooseEntry`. `extractMetadata`, with each file's `read` coming from `blobs.get`. `commitVersion`. `stager.release()`.
  7. Any error: `await stager.abort()`, destroy the input, rethrow.

  `ingestFiles` runs steps 5–7 over buffers. `ingestInline` first rejects non-text paths (`isTextType(contentTypeFor(path))`) with `badRequest(t('publish.inline.textOnly', { path }), { reason: 'inline_text_only', path })`. Then it sums `Buffer.byteLength(content, 'utf8')` against `maxInlineBytes` and calls `ingestFiles`.
  en.json:
  - `"publish.unsupported": "Send a tar, tar.gz or zip archive, or a single file with Content-Type text/html or text/markdown, or add ?filename=<name> to the URL."`
  - `"publish.inline.textOnly": "{{path}}: inline publish takes text files only (HTML, Markdown, CSS, JavaScript, SVG, JSON). Use an upload URL for other files."`
- [ ] **Step 4: Run** the Step 2 command, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): ingest archives, single files, file sets and inline text into versions`.

---

## M4a done when

- `pnpm lint && pnpm typecheck && pnpm test` pass, and `pnpm test:integration` passes with the M4a suites run on both SQLite and Postgres.
- The Review Focus tests owned by Tasks 1–6 pass.
