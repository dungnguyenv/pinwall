import { HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import i18n from '../i18n.ts';
import { fx } from '../test/fixtures.ts';
import { API, apiError, server } from '../test/server.ts';
import {
  ApiError,
  api,
  apiUrl,
  errorMessage,
  isApiError,
  setUnauthorizedHandler,
} from './client.ts';
import { Me } from './dto.ts';

afterEach(() => setUnauthorizedHandler(null));

test('builds URLs on the app origin and drops empty query values', () => {
  expect(
    apiUrl('/projects', { q: 'a b', archived: false, limit: 20, cursor: null, x: undefined }),
  ).toBe(`${location.origin}/api/v1/projects?q=a+b&archived=false&limit=20`);
  expect(apiUrl('/me')).toBe(`${location.origin}/api/v1/me`);
});

test('parses responses with the shared schema and sends JSON', async () => {
  server.use(
    http.post(`${API}/echo`, async ({ request }) => {
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(await request.json()).toEqual({ a: 1 });
      return HttpResponse.json({ ...fx.me(), extra: 1 });
    }),
  );
  const me = await api('/echo', { method: 'POST', body: { a: 1 }, schema: Me });
  expect(me).toEqual(fx.me());
  expect(me).not.toHaveProperty('extra');
});

test('a request without a body sends no content type', async () => {
  server.use(
    http.get(`${API}/me`, ({ request }) => {
      expect(request.headers.get('content-type')).toBeNull();
      return HttpResponse.json(fx.me());
    }),
  );
  await expect(api('/me', { schema: Me })).resolves.toEqual(fx.me());
});

test('server error messages pass through verbatim', async () => {
  server.use(
    http.post(`${API}/me/tokens`, () =>
      apiError(409, 'conflict', 'You have reached the limit of 100 API tokens. Revoke one first.'),
    ),
  );
  const e = await api('/me/tokens', { method: 'POST', body: {} }).catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ status: 409, code: 'conflict' });
  expect(errorMessage(e, i18n.t)).toBe(
    'You have reached the limit of 100 API tokens. Revoke one first.',
  );
});

test('a non-JSON error falls back to an i18n message', async () => {
  for (const [status, key] of [
    [502, 'web.error.unavailable'],
    [504, 'web.error.unavailable'],
    [413, 'web.error.tooLarge'],
    [500, 'web.error.generic'],
  ] as const) {
    server.use(
      http.get(
        `${API}/x`,
        () =>
          new HttpResponse('<html>Bad gateway</html>', {
            status,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const e = await api('/x').catch((x) => x);
    expect(e).toMatchObject({ status, code: `http_${status}` });
    expect(errorMessage(e, i18n.t)).toBe(i18n.t(key));
  }
});

test('JSON that is not an error body is treated like any other non-Pinwall error', async () => {
  server.use(http.get(`${API}/x`, () => HttpResponse.json({ message: 'nope' }, { status: 503 })));
  const e = await api('/x').catch((x) => x);
  expect(e).toMatchObject({ status: 503, code: 'http_503' });
  expect(errorMessage(e, i18n.t)).toBe(i18n.t('web.error.unavailable'));
});

test('a dropped connection is a network error', async () => {
  server.use(http.get(`${API}/x`, () => HttpResponse.error()));
  const e = await api('/x').catch((x) => x);
  expect(e).toMatchObject({ status: 0, code: 'network' });
  expect(errorMessage(e, i18n.t)).toBe(i18n.t('web.error.network'));
});

test('an aborted request rejects with the abort, not a network error', async () => {
  server.use(http.get(`${API}/x`, () => HttpResponse.json({})));
  const controller = new AbortController();
  controller.abort();
  const e = await api('/x', { signal: controller.signal }).catch((x) => x);
  expect(isApiError(e)).toBe(false);
  expect(e).toHaveProperty('name', 'AbortError');
});

test('a malformed success body is invalid_response', async () => {
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json({ nope: 1 })),
    http.get(`${API}/html`, () => new HttpResponse('<!doctype html>', { status: 200 })),
  );
  for (const path of ['/me', '/html']) {
    const e = await api(path, { schema: Me }).catch((x) => x);
    expect(e).toMatchObject({ status: 200, code: 'invalid_response' });
    expect(errorMessage(e, i18n.t)).toBe(i18n.t('web.error.invalid_response'));
  }
});

test('a 204 resolves undefined', async () => {
  server.use(http.post(`${API}/auth/sign-out`, () => new HttpResponse(null, { status: 204 })));
  await expect(api('/auth/sign-out', { method: 'POST' })).resolves.toBeUndefined();
});

test('401 unauthorized calls the handler; invalid_credentials and redirectOn401 false do not', async () => {
  const onUnauthorized = vi.fn();
  setUnauthorizedHandler(onUnauthorized);
  server.use(
    http.get(`${API}/projects`, () => apiError(401, 'unauthorized', 'Sign in to continue.')),
    http.post(`${API}/auth/password`, () =>
      apiError(401, 'invalid_credentials', 'Wrong password.'),
    ),
  );

  const e = await api('/projects').catch((x) => x);
  expect(isApiError(e, 'unauthorized')).toBe(true);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);

  const wrong = await api('/auth/password', { method: 'POST', body: { password: 'x' } }).catch(
    (x) => x,
  );
  expect(errorMessage(wrong, i18n.t)).toBe('Wrong password.');
  await api('/projects', { redirectOn401: false }).catch(() => undefined);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});

test('rate limits say when to retry', async () => {
  server.use(
    http.post(`${API}/auth/password`, () =>
      apiError(429, 'rate_limited', 'Too many requests. Retry in 42 seconds.', {
        retry_after_seconds: 42,
      }),
    ),
  );
  const e = await api('/auth/password', { method: 'POST', body: { password: 'x' } }).catch(
    (x) => x,
  );
  expect(e).toMatchObject({
    status: 429,
    code: 'rate_limited',
    details: { retry_after_seconds: 42 },
  });
  expect(errorMessage(e, i18n.t)).toBe('Too many requests. Retry in 42 seconds.');
});

test('anything that is not an ApiError gets the generic message', () => {
  expect(errorMessage(new TypeError('x is undefined'), i18n.t)).toBe(i18n.t('web.error.generic'));
  expect(isApiError(new Error('x'))).toBe(false);
  expect(isApiError(new ApiError(404, 'not_found', 'Gone.'), 'conflict')).toBe(false);
});
