import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loggablePath } from '../../src/http/logging.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

test('every response is logged once with its request id, status and duration', async () => {
  const info = vi.spyOn(ctx.deps.logger, 'info');
  const r = await ctx.request('/definitely/not/here?token=setup-secret');

  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith(
    {
      request_id: r.headers.get('x-request-id'),
      method: 'GET',
      path: '/definitely/not/here',
      status: 404,
      duration_ms: expect.any(Number),
      ip: 'unknown',
    },
    'request',
  );
});

test('health probes are logged at debug level only', async () => {
  const info = vi.spyOn(ctx.deps.logger, 'info');
  const debug = vi.spyOn(ctx.deps.logger, 'debug');
  await ctx.request('/healthz');
  expect(info).not.toHaveBeenCalled();
  expect(debug).toHaveBeenCalledWith(expect.objectContaining({ path: '/healthz' }), 'request');
});

test('tokens in paths never reach the log', () => {
  expect(loggablePath('/c/abc123/index.html')).toBe('/c/:token/index.html');
  expect(loggablePath('/s/share-secret')).toBe('/s/:token');
  expect(loggablePath('/upload/upload-secret')).toBe('/upload/:token');
  expect(loggablePath('/a/art_1/raw')).toBe('/a/art_1/raw');
  expect(loggablePath('/settings/tokens')).toBe('/settings/tokens');
});
