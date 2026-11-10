import { expect, test } from 'vitest';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  gone,
  notFound,
  payloadTooLarge,
  rateLimited,
  unauthorized,
  unsupportedMediaType,
} from '../../src/lib/errors.ts';

test('error factories set status and code', () => {
  expect(notFound('x')).toMatchObject({ status: 404, code: 'not_found', message: 'x' });
  expect(rateLimited(30)).toMatchObject({ status: 429, details: { retry_after_seconds: 30 } });
});

test('every factory maps to its status and code', () => {
  expect(badRequest('m', { field: 'a' })).toMatchObject({
    status: 400,
    code: 'bad_request',
    details: { field: 'a' },
  });
  expect(unauthorized('m')).toMatchObject({ status: 401, code: 'unauthorized' });
  expect(forbidden('m')).toMatchObject({ status: 403, code: 'forbidden' });
  expect(conflict('m')).toMatchObject({ status: 409, code: 'conflict' });
  expect(gone('m')).toMatchObject({ status: 410, code: 'gone' });
  expect(payloadTooLarge('m')).toMatchObject({ status: 413, code: 'payload_too_large' });
  expect(unsupportedMediaType('m')).toMatchObject({ status: 415, code: 'unsupported_media_type' });
  expect(rateLimited(1)).toMatchObject({ status: 429, code: 'rate_limited' });
});

test('AppError is an Error with a stack and optional details', () => {
  const e = new AppError('version_conflict', 409, 'stale', { current: 3 });
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('AppError');
  expect(e.details).toEqual({ current: 3 });
  expect(notFound('x').details).toBeUndefined();
});
