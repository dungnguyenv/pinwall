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
  expect(loggablePath('/s/share-secret/original')).toBe('/s/:token/original');
  expect(loggablePath('/upload/upload-secret')).toBe('/upload/:token');
  // The share viewer's API carries the share token too.
  expect(loggablePath('/api/v1/share/share-secret')).toBe('/api/v1/share/:token');
  expect(loggablePath('/api/v1/share/share-secret/unlock')).toBe('/api/v1/share/:token/unlock');
  expect(loggablePath('/api/v1/share/share-secret/comments/cmt_1')).toBe(
    '/api/v1/share/:token/comments/cmt_1',
  );
  expect(loggablePath('/api/v1/share/share-secret/events')).toBe('/api/v1/share/:token/events');
  // So does the consent page's API, with the id of a pending OAuth authorization.
  expect(loggablePath('/api/v1/oauth/requests/consent-secret')).toBe(
    '/api/v1/oauth/requests/:token',
  );
  expect(loggablePath('/api/v1/oauth/requests/consent-secret/decision')).toBe(
    '/api/v1/oauth/requests/:token/decision',
  );
  // Member routes hold ids, not secrets.
  expect(loggablePath('/api/v1/share-links/shr_1')).toBe('/api/v1/share-links/shr_1');
  expect(loggablePath('/api/v1/artifacts/art_1/share-links')).toBe(
    '/api/v1/artifacts/art_1/share-links',
  );
  expect(loggablePath('/a/art_1/raw')).toBe('/a/art_1/raw');
  expect(loggablePath('/settings/tokens')).toBe('/settings/tokens');
});

test('a share viewer request is logged without its token', async () => {
  const info = vi.spyOn(ctx.deps.logger, 'info');
  const secret = 'S'.repeat(43);
  for (const path of [`/api/v1/share/${secret}`, `/api/v1/share/${secret}/events`]) {
    await ctx.request(path);
  }
  expect(info.mock.calls.map(([line]) => (line as { path: string }).path)).toEqual([
    '/api/v1/share/:token',
    '/api/v1/share/:token/events',
  ]);
  expect(JSON.stringify(info.mock.calls)).not.toContain(secret);
});
