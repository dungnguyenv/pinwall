import { expect, test } from 'vitest';
import { EXPANSION_FLOOR_BYTES, IngestBudget, limitExceeded } from '../../src/publish/limits.ts';

const L = {
  maxUploadBytes: 1000,
  maxInlineBytes: 100,
  maxFileBytes: 300,
  maxVersionBytes: 500,
  maxFiles: 2,
  maxExpansionRatio: 10,
};

const tooLarge = (details: Record<string, unknown>) =>
  expect.objectContaining({ status: 413, code: 'payload_too_large', details });

test('request bytes over the limit', () => {
  const b = new IngestBudget(L);
  b.onRequestBytes(1000);
  expect(() => b.onRequestBytes(1)).toThrow(tooLarge({ limit: 'max_upload_bytes', max: 1000 }));
});

test('file, version and count limits', () => {
  const declared = new IngestBudget(L);
  expect(() => declared.startFile('a', 301)).toThrow(
    tooLarge({ limit: 'max_file_bytes', max: 300, path: 'a' }),
  );

  const counted = new IngestBudget(L);
  counted.startFile('a', null);
  counted.onFileBytes(300);
  expect(() => counted.onFileBytes(1)).toThrow(
    tooLarge({ limit: 'max_file_bytes', max: 300, path: 'a' }),
  );

  const version = new IngestBudget(L);
  version.startFile('a', 250);
  version.onFileBytes(250);
  version.startFile('b', null);
  version.onFileBytes(250);
  expect(() => version.onFileBytes(1)).toThrow(tooLarge({ limit: 'max_version_bytes', max: 500 }));

  const count = new IngestBudget(L);
  count.startFile('a', 0);
  count.startFile('b', 0);
  expect(() => count.startFile('c', 0)).toThrow(tooLarge({ limit: 'max_files', max: 2 }));
});

test('the per-file count starts again with each file', () => {
  const b = new IngestBudget({ ...L, maxVersionBytes: 1000 });
  b.startFile('a', null);
  b.onFileBytes(300);
  b.startFile('b', null);
  expect(() => b.onFileBytes(300)).not.toThrow();
});

test('expansion ratio uses a 64 KiB floor', () => {
  expect(EXPANSION_FLOOR_BYTES).toBe(65_536);
  const b = new IngestBudget(L);
  b.onRequestBytes(1000);
  b.onExpandedBytes(655_360);
  expect(() => b.onExpandedBytes(1)).toThrow(tooLarge({ limit: 'max_expansion_ratio', max: 10 }));
});

test('expansion ratio follows the request size above the floor', () => {
  const b = new IngestBudget({ ...L, maxUploadBytes: 1_000_000 });
  b.onRequestBytes(100_000);
  b.onExpandedBytes(1_000_000);
  expect(() => b.onExpandedBytes(1)).toThrow(tooLarge({ limit: 'max_expansion_ratio', max: 10 }));
});

test('limit messages name the setting and quote the path', () => {
  expect(limitExceeded('max_upload_bytes', 95_000_000).message).toBe(
    'The upload is larger than the limit of 95000000 bytes (PINWALL_MAX_UPLOAD_BYTES).',
  );
  expect(limitExceeded('max_file_bytes', 300, 'big.bin').message).toBe(
    'big.bin is larger than the per-file limit of 300 bytes (PINWALL_MAX_FILE_BYTES).',
  );
  const long = 'd/'.repeat(80);
  expect(limitExceeded('max_file_bytes', 300, long).message).toBe(
    `${long.slice(0, 100)}… is larger than the per-file limit of 300 bytes (PINWALL_MAX_FILE_BYTES).`,
  );
  expect(limitExceeded('max_inline_bytes', 100)).toMatchObject({
    status: 413,
    details: { limit: 'max_inline_bytes', max: 100 },
    message:
      'The inline files add up to more than 100 bytes (PINWALL_MAX_INLINE_BYTES). Use an upload URL instead.',
  });
});
