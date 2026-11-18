import { gunzipSync, gzipSync } from 'node:zlib';
import { type ZipOptions, type Zippable, zipSync } from 'fflate';
import { extract, pack } from 'tar-stream';

export interface TarSpec {
  name: string;
  body?: string | Buffer;
  type?: 'file' | 'directory' | 'symlink' | 'link' | 'character-device';
  linkname?: string;
}

/** A tar archive of `entries` in order, gzipped when `o.gzip` is set. */
export async function makeTar(entries: TarSpec[], o: { gzip?: boolean } = {}): Promise<Buffer> {
  const archive = pack();
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const header = { name: entry.name, type, linkname: entry.linkname };
    if (type === 'file') archive.entry(header, Buffer.from(entry.body ?? ''));
    else archive.entry(header);
  }
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(chunk as Buffer);
  const tar = Buffer.concat(chunks);
  return o.gzip ? gzipSync(tar) : tar;
}

/**
 * The entries of a tar archive, gzipped or not, in the order they are stored: a response, or its
 * bytes. Reads it whole, so it is for archives a test made small.
 */
export async function untar(
  source: Response | Buffer,
): Promise<{ path: string; type: string; body: Buffer }[]> {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(await source.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const archive = extract();
  archive.end(gzipped ? gunzipSync(bytes) : bytes);
  const entries: { path: string; type: string; body: Buffer }[] = [];
  for await (const entry of archive) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(chunk as Buffer);
    entries.push({ path: entry.header.name, type: entry.header.type, body: Buffer.concat(chunks) });
  }
  return entries;
}

/** The paths of the entries of a tar archive, in the order they are stored; see `untar`. */
export async function untarPaths(source: Response | Buffer): Promise<string[]> {
  return (await untar(source)).map((entry) => entry.path);
}

export interface ZipSpec {
  name: string;
  body?: string | Buffer;
  /** Unix `st_mode`, written as the upper half of the external attributes. */
  mode?: number;
  level?: 0 | 6;
}

/** A zip archive of `entries` in order; level 0 stores, level 6 (the default) deflates. */
export function makeZip(entries: ZipSpec[]): Buffer {
  const files: Zippable = {};
  for (const entry of entries) {
    const level = entry.level ?? 6;
    const options: ZipOptions =
      entry.mode === undefined ? { level } : { level, os: 3, attrs: entry.mode << 16 };
    files[entry.name] = [new Uint8Array(Buffer.from(entry.body ?? '')), options];
  }
  return Buffer.from(zipSync(files));
}
