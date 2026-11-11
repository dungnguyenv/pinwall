import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { crc32, gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import {
  type ArchiveEntry,
  type ArchiveFormat,
  readArchive,
  sniffArchive,
} from '../../src/publish/archive.ts';
import { IngestBudget } from '../../src/publish/limits.ts';
import { rejectPath } from '../../src/publish/paths.ts';
import { readZipDirectory } from '../../src/publish/zip.ts';
import { makeTar, makeZip } from '../helpers/archives.ts';

const roomy = {
  maxUploadBytes: 1e9,
  maxInlineBytes: 1e9,
  maxFileBytes: 1e9,
  maxVersionBytes: 1e9,
  maxFiles: 100_000,
  maxExpansionRatio: 1e6,
};

async function readBody(e: ArchiveEntry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of e.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Every entry in order, with its body read to the end. */
async function collect(buf: Buffer, format: ArchiveFormat, budget = new IngestBudget(roomy)) {
  const entries: { rawPath: string; type: string; size: number | null; text: string }[] = [];
  await readArchive(Readable.from(buf), format, budget, async (e) => {
    const body = await readBody(e);
    entries.push({ rawPath: e.rawPath, type: e.type, size: e.size, text: body.toString() });
  });
  return entries;
}

/** Deterministic bytes that do not compress. */
function noise(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Offsets of the end-of-central-directory record and of each central directory record. */
function zipLayout(zip: Buffer): { eocd: number; central: number[] } {
  const eocd = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  const central: number[] = [];
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i += 1) {
    central.push(at);
    at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return { eocd, central };
}

/** Rewrites the checksum of the tar header at `at` after a field was patched. */
function fixTarChecksum(tar: Buffer, at: number): void {
  tar.fill(0x20, at + 148, at + 156);
  let sum = 0;
  for (let i = at; i < at + 512; i += 1) sum += tar[i] ?? 0;
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, at + 148, 'latin1');
}

const corrupt = { status: 400, code: 'bad_request', details: { reason: 'corrupt_archive' } };

test('sniffs formats by magic bytes', async () => {
  expect(sniffArchive(await makeTar([{ name: 'a', body: 'x' }], { gzip: true }))).toBe('tar.gz');
  expect(sniffArchive(await makeTar([{ name: 'a', body: 'x' }]))).toBe('tar');
  expect(sniffArchive(makeZip([{ name: 'a', body: 'x' }]))).toBe('zip');
  expect(sniffArchive(makeZip([]))).toBe('zip');
  expect(sniffArchive(Buffer.from('<!doctype html>'))).toBeNull();
  expect(sniffArchive(Buffer.alloc(0))).toBeNull();
});

describe.each(['tar', 'tar.gz'] as const)('%s', (format) => {
  const make = (entries: Parameters<typeof makeTar>[0]) =>
    makeTar(entries, { gzip: format === 'tar.gz' });

  test('reads entries with their types', async () => {
    const archive = await make([
      { name: './', type: 'directory' },
      { name: './index.html', body: '<h1>x</h1>' },
      { name: './l', type: 'symlink', linkname: '/etc/passwd' },
      { name: './h', type: 'link', linkname: './index.html' },
      { name: './dev', type: 'character-device' },
    ]);
    expect(await collect(archive, format)).toEqual([
      { rawPath: './', type: 'directory', size: 0, text: '' },
      { rawPath: './index.html', type: 'file', size: 10, text: '<h1>x</h1>' },
      { rawPath: './l', type: 'symlink', size: 0, text: '' },
      { rawPath: './h', type: 'hardlink', size: 0, text: '' },
      { rawPath: './dev', type: 'other', size: 0, text: '' },
    ]);
  });

  test('reads long and non-ASCII names from pax headers', async () => {
    const long = `docs/${'x'.repeat(295)}`;
    const nfd = 'Tài liệu/đề.html'.normalize('NFD');
    const entries = await collect(
      await make([
        { name: long, body: 'long' },
        { name: nfd, body: 'nfd' },
      ]),
      format,
    );
    expect(long).toHaveLength(300);
    expect(entries.map((e) => [e.rawPath, e.text])).toEqual([
      [long, 'long'],
      [nfd, 'nfd'],
    ]);
  });

  test('a body left unread is skipped', async () => {
    const archive = await make([
      { name: '._junk', body: noise(300_000) },
      { name: 'index.html', body: 'kept' },
    ]);
    const read: Record<string, string> = {};
    await readArchive(Readable.from(archive), format, new IngestBudget(roomy), async (e) => {
      if (e.rawPath === 'index.html') read[e.rawPath] = (await readBody(e)).toString();
    });
    expect(read).toEqual({ 'index.html': 'kept' });
  });

  test('errors thrown by onEntry propagate unchanged', async () => {
    const error = rejectPath('x', 'link');
    const archive = await make([{ name: 'a', body: noise(100_000) }]);
    await expect(
      readArchive(Readable.from(archive), format, new IngestBudget(roomy), async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  test('errors from the input stream propagate unchanged', async () => {
    const error = new Error('connection reset');
    const archive = await make([{ name: 'a', body: noise(100_000) }]);
    const input = new Readable({ read() {} });
    input.push(archive.subarray(0, 2_000));
    setImmediate(() => input.destroy(error));
    await expect(
      readArchive(input, format, new IngestBudget(roomy), async (e) => {
        await readBody(e);
      }),
    ).rejects.toBe(error);
  });
});

test.each([
  ['a tar.gz cut in half', 'tar.gz'],
  ['1f 8b followed by noise', 'tar.gz'],
  ['a tar with a damaged header', 'tar'],
  ['a tar cut inside an entry', 'tar'],
  ['a tar.gz of a damaged tar', 'tar.gz'],
] as const)('%s is bad_request corrupt_archive', async (name, format) => {
  const body = noise(50_000);
  const tar = await makeTar([
    { name: 'a.bin', body },
    { name: 'b.bin', body },
  ]);
  const damaged = Buffer.from(tar);
  damaged[0] = 0x41;
  const tgz = await makeTar([{ name: 'a.bin', body }], { gzip: true });
  const input = {
    'a tar.gz cut in half': tgz.subarray(0, tgz.length >> 1),
    '1f 8b followed by noise': Buffer.concat([Buffer.from([0x1f, 0x8b]), noise(1_000)]),
    'a tar with a damaged header': damaged,
    'a tar cut inside an entry': tar.subarray(0, 512 + 20_000),
    'a tar.gz of a damaged tar': gzipSync(damaged),
  }[name];
  await expect(collect(input, format)).rejects.toMatchObject(corrupt);
});

test('a tar size field tar-stream cannot parse is corrupt, not a stall', async () => {
  const tar = await makeTar([
    { name: 'f.txt', body: 'hello' },
    { name: 'g.txt', body: 'x' },
  ]);
  tar[124] = 0x81; // marks a base-256 size, but only 0x80 and 0xff are defined
  fixTarChecksum(tar, 0);
  await expect(collect(tar, 'tar')).rejects.toMatchObject(corrupt);
});

test('a directory header that declares a size does not stall', async () => {
  const tar = await makeTar([
    { name: 'd/', type: 'directory' },
    { name: 'g.txt', body: 'x' },
  ]);
  tar.write('00000001000', 124, 'latin1');
  fixTarChecksum(tar, 0);
  expect(await collect(tar, 'tar')).toEqual([
    { rawPath: 'd/', type: 'directory', size: 0, text: '' },
    { rawPath: 'g.txt', type: 'file', size: 1, text: 'x' },
  ]);
});

test('reads zip entries with unix types', async () => {
  const zip = makeZip([
    { name: 'a.txt', body: 'hi' },
    { name: 'd/' },
    { name: 'l', body: 'a.txt', mode: 0o120777 },
    { name: 'dev', mode: 0o020644 },
    { name: 'x.html', body: 'x', mode: 0o100644 },
    { name: 'sub', mode: 0o040755 },
  ]);
  expect(await collect(zip, 'zip')).toEqual([
    { rawPath: 'a.txt', type: 'file', size: 2, text: 'hi' },
    { rawPath: 'd/', type: 'directory', size: 0, text: '' },
    { rawPath: 'l', type: 'symlink', size: 0, text: '' },
    { rawPath: 'dev', type: 'other', size: 0, text: '' },
    { rawPath: 'x.html', type: 'file', size: 1, text: 'x' },
    { rawPath: 'sub', type: 'directory', size: 0, text: '' },
  ]);
  expect(readZipDirectory(zip)[0]).toEqual({
    name: 'a.txt',
    type: 'file',
    method: 8,
    compressedSize: expect.any(Number),
    size: 2,
    crc32: crc32('hi'),
    localHeaderOffset: 0,
    encrypted: false,
  });
});

test('errors from a zip input stream propagate unchanged', async () => {
  const error = new Error('connection reset');
  const input = new Readable({ read() {} });
  input.push(makeZip([{ name: 'a', body: 'x' }]).subarray(0, 10));
  setImmediate(() => input.destroy(error));
  await expect(readArchive(input, 'zip', new IngestBudget(roomy), async () => {})).rejects.toBe(
    error,
  );
});

test('zip names are UTF-8, or latin1 when they are not valid UTF-8', async () => {
  const nfd = 'Tài liệu/đề.html'.normalize('NFD');
  const zip = makeZip([
    { name: nfd, body: 'nfd' },
    { name: 'caf_.txt', body: 'latin1' },
  ]);
  const { central } = zipLayout(zip);
  const second = central[1] ?? 0;
  zip[second + 46 + 3] = 0xe9;
  expect((await collect(zip, 'zip')).map((e) => [e.rawPath, e.text])).toEqual([
    [nfd, 'nfd'],
    ['café.txt', 'latin1'],
  ]);
});

test.each([0, 6] as const)('zip entries at level %i round-trip', async (level) => {
  const data = randomBytes(200_000);
  const zip = makeZip([{ name: 'r.bin', body: data, level }]);
  expect(readZipDirectory(zip)[0]?.method).toBe(level === 0 ? 0 : 8);
  let read: Buffer = Buffer.alloc(0);
  await readArchive(Readable.from(zip), 'zip', new IngestBudget(roomy), async (e) => {
    read = await readBody(e);
  });
  expect(read.equals(data)).toBe(true);
});

test('a zip body left unread is skipped', async () => {
  const zip = makeZip([
    { name: '._junk', body: noise(300_000) },
    { name: 'index.html', body: 'kept' },
  ]);
  const read: Record<string, string> = {};
  await readArchive(Readable.from(zip), 'zip', new IngestBudget(roomy), async (e) => {
    if (e.rawPath === 'index.html') read[e.rawPath] = (await readBody(e)).toString();
  });
  expect(read).toEqual({ 'index.html': 'kept' });
});

test.each([
  'one CRC byte flipped',
  'the end record cut off',
  'a local header past the end',
  'a size that does not match the data',
  'a stored entry whose sizes differ',
])('a zip with %s is bad_request corrupt_archive', async (damage) => {
  const zip = makeZip([
    { name: 'a.txt', body: noise(5_000) },
    { name: 'b.txt', body: noise(5_000, 2), level: 0 },
  ]);
  const { central } = zipLayout(zip);
  const [first = 0, second = 0] = central;
  let input = zip;
  if (damage === 'one CRC byte flipped') zip[first + 16] = (zip[first + 16] ?? 0) ^ 0xff;
  if (damage === 'the end record cut off') input = zip.subarray(0, zip.length - 10);
  if (damage === 'a local header past the end') zip.writeUInt32LE(0x7fff_0000, first + 42);
  if (damage === 'a size that does not match the data') zip.writeUInt32LE(4_000, first + 24);
  if (damage === 'a stored entry whose sizes differ') zip.writeUInt32LE(4_000, second + 24);
  await expect(collect(input, 'zip')).rejects.toMatchObject(corrupt);
});

test('zip entries that share their data are refused before any is read', async () => {
  // Two names over one deflated stream: every entry reads fine alone, and that is how a small zip
  // expands into many large files.
  const body = Buffer.alloc(100_000, 0x61);
  const zip = makeZip([
    { name: 'a.txt', body },
    { name: 'b.txt', body },
  ]);
  const second = zipLayout(zip).central[1] ?? 0;
  zip.writeUInt32LE(0, second + 42);
  expect(() => readZipDirectory(zip)).toThrow(expect.objectContaining(corrupt));
  let calls = 0;
  await expect(
    readArchive(Readable.from(zip), 'zip', new IngestBudget(roomy), async () => {
      calls += 1;
    }),
  ).rejects.toMatchObject(corrupt);
  expect(calls).toBe(0);
});

test.each([
  ['zip', () => makeZip([{ name: 'a.bin', body: noise(5_000) }]), 'crc'],
  [
    'tar.gz',
    () => makeTar([{ name: 'z.bin', body: Buffer.alloc(10_000_000) }], { gzip: true }),
    'bomb',
  ],
] as const)(
  '%s: a body failure rejects even when onEntry swallows it',
  async (format, make, kind) => {
    const archive = await make();
    if (kind === 'crc') {
      const crc = (zipLayout(archive).central[0] ?? 0) + 16;
      archive[crc] = (archive[crc] ?? 0) ^ 0xff;
    }
    const budget = new IngestBudget({ ...roomy, maxExpansionRatio: 100 });
    budget.onRequestBytes(archive.length);
    let swallowed: unknown = null;
    const reading = readArchive(Readable.from(archive), format, budget, async (e) => {
      await readBody(e).catch((error: unknown) => {
        swallowed = error;
      });
    });
    const expected = kind === 'crc' ? corrupt : { details: { limit: 'max_expansion_ratio' } };
    await expect(reading).rejects.toMatchObject(expected);
    expect(swallowed).toMatchObject(expected);
  },
);

test('zip64 is refused with a hint', async () => {
  const zip = makeZip([{ name: 'a.txt', body: 'x' }]);
  const { eocd, central } = zipLayout(zip);
  const count = Buffer.from(zip);
  count.writeUInt16LE(0xffff, eocd + 8);
  count.writeUInt16LE(0xffff, eocd + 10);
  const size = Buffer.from(zip);
  size.writeUInt32LE(0xffff_ffff, (central[0] ?? 0) + 24);
  for (const input of [count, size]) {
    await expect(collect(input, 'zip')).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_media_type',
      message: t('publish.archive.zip64'),
    });
  }
});

test('encrypted zip entries are refused', async () => {
  const zip = makeZip([{ name: 'secret.txt', body: 'x' }]);
  const flags = (zipLayout(zip).central[0] ?? 0) + 8;
  zip.writeUInt16LE(zip.readUInt16LE(flags) | 1, flags);
  await expect(collect(zip, 'zip')).rejects.toMatchObject({
    status: 400,
    details: { reason: 'encrypted', path: 'secret.txt' },
    message: 'secret.txt is encrypted, and encrypted archives are not supported.',
  });
});

test('zip methods other than store and deflate are refused', async () => {
  const zip = makeZip([{ name: 'b.txt', body: 'x' }]);
  zip.writeUInt16LE(12, (zipLayout(zip).central[0] ?? 0) + 10);
  await expect(collect(zip, 'zip')).rejects.toMatchObject({
    status: 400,
    details: { reason: 'zip_method', path: 'b.txt' },
  });
});

describe('an expansion bomb stops early', () => {
  const bombs = {
    'tar.gz': () => makeTar([{ name: 'z.bin', body: Buffer.alloc(10_000_000) }], { gzip: true }),
    zip: async () => makeZip([{ name: 'z.bin', body: Buffer.alloc(10_000_000) }]),
  };

  test.each(['tar.gz', 'zip'] as const)('%s', async (format) => {
    const budget = new IngestBudget({ ...roomy, maxExpansionRatio: 100 });
    const archive = await bombs[format]();
    budget.onRequestBytes(archive.length); // ingest counts request bytes upstream; do the same here
    let read = 0;
    await expect(
      readArchive(Readable.from(archive), format, budget, async (e) => {
        for await (const c of e.body) read += c.length;
      }),
    ).rejects.toMatchObject({ status: 413, details: { limit: 'max_expansion_ratio', max: 100 } });
    expect(read).toBeLessThan(10_000_000);
  });

  test('zip: a deflated entry is inflated in chunks of at most 64 KiB, never whole', async () => {
    // 40 MB of zeros deflate to about 40 KB, so one 64 KiB feed would inflate all of it at once.
    const archive = makeZip([{ name: 'z.bin', body: Buffer.alloc(40_000_000) }]);
    const budget = new IngestBudget({ ...roomy, maxExpansionRatio: 100 });
    budget.onRequestBytes(archive.length);
    const baseline = process.memoryUsage().arrayBuffers;
    let largestChunk = 0;
    let peakGrowth = 0;
    const count = budget.onExpandedBytes.bind(budget);
    budget.onExpandedBytes = (n) => {
      largestChunk = Math.max(largestChunk, n);
      peakGrowth = Math.max(peakGrowth, process.memoryUsage().arrayBuffers - baseline);
      count(n);
    };
    await expect(
      readArchive(Readable.from(archive), 'zip', budget, async (e) => {
        for await (const _ of e.body) {
          // discarded as it arrives
        }
      }),
    ).rejects.toMatchObject({ status: 413, details: { limit: 'max_expansion_ratio' } });
    expect(largestChunk).toBeLessThanOrEqual(65_536);
    // About 6.5 MB of chunks is inflated before the ratio stops it; nothing near 40 MB is held.
    expect(peakGrowth).toBeLessThan(16_000_000);
  });

  test.each(['tar.gz', 'zip'] as const)(
    '%s: the rejection waits for the running onEntry',
    async (format) => {
      const budget = new IngestBudget({ ...roomy, maxExpansionRatio: 100 });
      const archive = await bombs[format]();
      budget.onRequestBytes(archive.length);
      let settled = false;
      const reading = readArchive(Readable.from(archive), format, budget, async (e) => {
        try {
          await readBody(e);
        } finally {
          await new Promise((resolve) => setTimeout(resolve, 20));
          settled = true;
        }
      });
      const error = (await reading.catch((e: unknown) => e)) as AppError;
      expect(error.details).toMatchObject({ limit: 'max_expansion_ratio' });
      expect(settled).toBe(true);
    },
  );
});
