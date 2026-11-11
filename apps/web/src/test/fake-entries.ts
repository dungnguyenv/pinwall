/*
 * Fake drops for the upload tests. jsdom has neither DataTransfer nor the
 * File and Directory Entries API, so these build the parts of both that
 * `lib/upload/collect.ts` reads, with the browser behaviors that matter:
 * a directory hands out its entries in batches, every callback runs later,
 * and the dropped items can go blank once the drop handler has returned.
 */

export type FakeNode =
  | { kind: 'file'; file: File; unreadable?: boolean }
  | { kind: 'dir'; name: string; children: FakeNode[] };

/** A file of `content`, or of `content` zero bytes when it is a number. */
export function file(
  name: string,
  content: string | number = `<!-- ${name} -->`,
  type = '',
): FakeNode {
  return {
    kind: 'file',
    file: new File([typeof content === 'number' ? new Uint8Array(content) : content], name, {
      type,
    }),
  };
}

/** A file whose read fails, as when it was deleted between the drop and the read. */
export function unreadable(name: string): FakeNode {
  return { kind: 'file', file: new File([], name), unreadable: true };
}

export function dir(name: string, children: FakeNode[]): FakeNode {
  return { kind: 'dir', name, children };
}

/** A File that reports `size` bytes without holding them, for limit checks. */
export function sizedFile(name: string, size: number): File {
  const f = new File([], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

/** A File as a folder input hands it over: with its path inside the chosen folder. */
export function folderFile(relativePath: string, content = `<!-- ${relativePath} -->`): File {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const f = new File([content], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
  return f;
}

export interface FakeDropOptions {
  /** Entries per readEntries() call; Chrome and Safari give at most 100. Default 100. */
  batch?: number;
  /**
   * Whether the items go blank once a microtask has passed, as they do in a
   * browser once the drop handler returns: webkitGetAsEntry() and getAsFile()
   * answer null and the item list is empty.
   */
  expires?: boolean;
  /** What dataTransfer.types lists. Default ['Files']. */
  types?: string[];
}

/** Runs `f` later, as the entries API answers in a later task. Microtasks keep fake timers out of it. */
function later(f: () => void): void {
  void Promise.resolve().then(f);
}

function toEntry(node: FakeNode, parent: string, batch: number): FileSystemEntry {
  if (node.kind === 'file') {
    const fullPath = `${parent}/${node.file.name}`;
    const entry = {
      isFile: true,
      isDirectory: false,
      name: node.file.name,
      fullPath,
      file(success: (f: File) => void, failure: (e: DOMException) => void) {
        later(() =>
          node.unreadable
            ? failure(new DOMException('A requested file could not be found.', 'NotFoundError'))
            : success(node.file),
        );
      },
    };
    return entry as unknown as FileSystemFileEntry;
  }
  const fullPath = `${parent}/${node.name}`;
  const entry = {
    isFile: false,
    isDirectory: true,
    name: node.name,
    fullPath,
    createReader() {
      let next = 0;
      return {
        readEntries(success: (entries: FileSystemEntry[]) => void) {
          const slice = node.children.slice(next, next + batch);
          next += slice.length;
          later(() => success(slice.map((child) => toEntry(child, fullPath, batch))));
        },
      };
    },
  };
  return entry as unknown as FileSystemDirectoryEntry;
}

/** A DataTransfer carrying `nodes` (files and folders) as a drop from the desktop does. */
export function fakeDrop(nodes: FakeNode[], o: FakeDropOptions = {}): DataTransfer {
  const batch = o.batch ?? 100;
  let alive = true;
  if (o.expires) later(() => (alive = false));

  const items = nodes.map((node) => {
    const entry = toEntry(node, '', batch);
    // Chrome hands out a File for a folder too; collect must go by the entry.
    const asFile = node.kind === 'file' ? node.file : new File([], node.name);
    return {
      kind: 'file',
      type: asFile.type,
      getAsFile: () => (alive ? asFile : null),
      webkitGetAsEntry: () => (alive ? entry : null),
      getAsString: () => {},
    };
  });
  const files = items.map((item) => item.getAsFile() as File);
  const types = o.types ?? ['Files'];
  const dt = {
    types,
    dropEffect: 'none',
    effectAllowed: 'all',
    get items() {
      return alive ? items : [];
    },
    get files() {
      return alive ? files : [];
    },
  };
  return dt as unknown as DataTransfer;
}
