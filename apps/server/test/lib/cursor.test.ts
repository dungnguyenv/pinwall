import { expect, test } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../src/lib/cursor.ts';
import { t } from '../../src/lib/i18n.ts';

const schema = z.object({ c: z.number(), i: z.string() });

test('a cursor round-trips through base64url', () => {
  const cursor = encodeCursor({ c: 5, i: 'usr_x' });
  expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeCursor(cursor, schema)).toEqual({ c: 5, i: 'usr_x' });
});

test('garbage is a bad_request with the page-link message', () => {
  const garbage = [
    'zz',
    '',
    '%%%',
    encodeCursor({ c: 'five', i: 1 }),
    Buffer.from('[1,2]').toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ];
  for (const cursor of garbage) {
    expect(() => decodeCursor(cursor, schema), cursor).toThrow(
      expect.objectContaining({ status: 400, code: 'bad_request', message: t('error.cursor') }),
    );
  }
});
