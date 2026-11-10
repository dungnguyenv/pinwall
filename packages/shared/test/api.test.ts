import { expect, test } from 'vitest';
import { z } from 'zod';
import { ErrorBody, Label, page, Timestamp } from '../src/index.ts';

test('Label trims and keeps 1 to 100 characters', () => {
  expect(Label.parse('  Laptop  ')).toBe('Laptop');
  expect(Label.safeParse('   ').success).toBe(false);
  expect(Label.safeParse('x'.repeat(100)).success).toBe(true);
  expect(Label.safeParse('x'.repeat(101)).success).toBe(false);
});

test('Timestamp is a whole number', () => {
  expect(Timestamp.safeParse(1_700_000_000_000).success).toBe(true);
  expect(Timestamp.safeParse(1.5).success).toBe(false);
});

test('page wraps items with a nullable cursor', () => {
  const schema = page(z.object({ id: z.string() }));
  expect(schema.parse({ items: [{ id: 'a' }], next_cursor: null })).toEqual({
    items: [{ id: 'a' }],
    next_cursor: null,
  });
  expect(schema.safeParse({ items: [{ id: 'a' }] }).success).toBe(false);
});

test('ErrorBody has an optional details object', () => {
  expect(ErrorBody.safeParse({ error: { code: 'x', message: 'y' } }).success).toBe(true);
  expect(
    ErrorBody.safeParse({ error: { code: 'x', message: 'y', details: { a: 1 } } }).success,
  ).toBe(true);
});
