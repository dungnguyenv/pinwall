import type { TFunction } from 'i18next';
import type { PublicConfig } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { formatBytes } from '../format.ts';

/** A file to publish and its path in the artifact: `index.html`, `site/css/a.css`. */
export interface UploadFile {
  path: string;
  file: File;
}

/** What a person chose to upload: one archive the server unpacks, or a set of files. */
export type UploadSelection =
  | { kind: 'archive'; file: File }
  | { kind: 'files'; files: UploadFile[] };

/** Names the server unpacks when the file comes alone. */
export const ARCHIVE_NAME = /\.(zip|tar|tgz|tar\.gz)$/i;

/** A file of the selection that could not be read, such as one deleted after the drop. */
export class UploadReadError extends Error {
  override readonly name = 'UploadReadError';

  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`Could not read ${path}`, options);
  }
}

const count = new Intl.NumberFormat('en');

/**
 * Files macOS leaves behind that are never part of a site: Finder's folder
 * settings, resource forks, and the folder zip adds for them. The server
 * skips them too; leaving them out here keeps them out of the size and count.
 */
function isJunk(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._');
}

/** macOS hands out names in NFD; links in HTML are NFC, and so are stored paths. */
function nfc(path: string): string {
  return path.normalize('NFC');
}

function byPath(a: UploadFile, b: UploadFile): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function isArchive(file: File): boolean {
  return ARCHIVE_NAME.test(file.name);
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

function readFile(entry: FileSystemFileEntry, path: string): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, (cause) => reject(new UploadReadError(path, { cause })));
  });
}

/**
 * Every entry of a folder. A reader hands them out in batches (at most 100 in
 * Chrome and Safari), so it is asked again until it answers with none.
 */
async function readFolder(
  entry: FileSystemDirectoryEntry,
  path: string,
): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, (cause) => reject(new UploadReadError(path, { cause })));
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** Adds the file, or every file under the folder, at `entry` to `out`. */
async function walk(entry: FileSystemEntry, parent: string, out: UploadFile[]): Promise<void> {
  if (isJunk(entry.name)) return;
  const path = parent + entry.name;
  if (isFileEntry(entry)) {
    out.push({ path: nfc(path), file: await readFile(entry, path) });
  } else if (isDirectoryEntry(entry)) {
    const children = await readFolder(entry, path);
    await Promise.all(children.map((child) => walk(child, `${path}/`, out)));
  }
}

/** One dropped item: its entry when the browser gives one, and its File. */
interface Dropped {
  entry: FileSystemEntry | null;
  file: File | null;
}

/**
 * Takes what the drop carries, synchronously. Browsers empty the item list
 * once the drop handler returns, so nothing here may wait.
 */
function takeDropped(dt: DataTransfer): Dropped[] {
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === 'file');
  if (items.length > 0) {
    return items.map((item) => ({
      entry: item.webkitGetAsEntry?.() ?? null,
      file: item.getAsFile(),
    }));
  }
  return Array.from(dt.files ?? []).map((file) => ({ entry: null, file }));
}

/**
 * What a drop holds: one lone archive file as an archive, anything else
 * (files, folders, or both) as files, with each folder walked to its last
 * file and paths like `site/css/a.css`, sorted. `null` when the drag carried
 * no files. Rejects with `UploadReadError` when any file cannot be read,
 * rather than uploading part of a folder.
 */
export async function collectFromDataTransfer(dt: DataTransfer): Promise<UploadSelection | null> {
  const dropped = takeDropped(dt);
  if (dropped.length === 0) return null;

  const [only] = dropped;
  if (dropped.length === 1 && only && !only.entry?.isDirectory) {
    const { entry, file } = only;
    const lone = file ?? (entry && isFileEntry(entry) ? await readFile(entry, entry.name) : null);
    if (lone && isArchive(lone) && !isJunk(lone.name)) return { kind: 'archive', file: lone };
  }

  const files: UploadFile[] = [];
  await Promise.all(
    dropped.map(async ({ entry, file }) => {
      // A top-level file is taken as the browser handed it over.
      if (file && !entry?.isDirectory) {
        if (!isJunk(file.name)) files.push({ path: nfc(file.name), file });
      } else if (entry) {
        await walk(entry, '', files);
      }
    }),
  );
  return { kind: 'files', files: files.sort(byPath) };
}

/**
 * What a file input chose. From a folder input, paths are the files' paths in
 * the chosen folder (`webkitRelativePath`), and an empty folder gives no files;
 * from a plain one, a lone archive is an archive and an empty list is `null`.
 */
export function collectFromFileList(
  list: FileList | File[],
  o: { folder: boolean },
): UploadSelection | null {
  const all = Array.from(list);
  if (o.folder) {
    const files = all
      .map((file) => ({ path: nfc(file.webkitRelativePath || file.name), file }))
      .filter(({ path }) => !path.split('/').some(isJunk));
    return { kind: 'files', files: files.sort(byPath) };
  }
  if (all.length === 0) return null;
  const [only] = all;
  if (all.length === 1 && only && isArchive(only) && !isJunk(only.name)) {
    return { kind: 'archive', file: only };
  }
  const files = all
    .filter((file) => !isJunk(file.name))
    .map((file) => ({ path: nfc(file.name), file }));
  return { kind: 'files', files: files.sort(byPath) };
}

/**
 * Size, file count and a short name for the selection: the archive's name,
 * the folder that holds every file, or the first file and how many more.
 */
export function selectionStats(s: UploadSelection): {
  bytes: number;
  files: number;
  label: string;
} {
  if (s.kind === 'archive') return { bytes: s.file.size, files: 1, label: s.file.name };
  const bytes = s.files.reduce((sum, { file }) => sum + file.size, 0);
  const [first] = s.files;
  if (!first) return { bytes, files: 0, label: '' };

  const slash = first.path.indexOf('/');
  const folder = slash > 0 ? first.path.slice(0, slash + 1) : null;
  if (folder && s.files.every(({ path }) => path.startsWith(folder))) {
    return { bytes, files: s.files.length, label: folder.slice(0, -1) };
  }
  const name = first.path.slice(first.path.lastIndexOf('/') + 1);
  const label =
    s.files.length === 1 ? name : i18n.t('web.upload.andMore', { name, count: s.files.length - 1 });
  return { bytes, files: s.files.length, label };
}

/**
 * Why the server would refuse the selection before a byte is sent, by the
 * limits it publishes; `null` when it is within them. The server still checks
 * everything (file size, version size, archive contents) on its side.
 */
export function checkSelection(
  s: UploadSelection,
  limits: PublicConfig['limits'],
  t: TFunction,
): string | null {
  const { bytes, files } = selectionStats(s);
  if (files === 0) return t('web.upload.empty');
  if (bytes > limits.max_upload_bytes) {
    return t('web.upload.tooLarge', {
      size: formatBytes(bytes),
      max: formatBytes(limits.max_upload_bytes),
    });
  }
  if (files > limits.max_files) {
    return t('web.upload.tooManyFiles', { max: count.format(limits.max_files) });
  }
  return null;
}
