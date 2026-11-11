import { HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import { API, apiError, server } from '../test/server.ts';
import { api } from './client.ts';
import { createQueryClient } from './query-client.ts';

/** Fetches once through the app's defaults and counts how often the server was asked. */
async function attempts(respond: () => Response): Promise<number> {
  let calls = 0;
  server.use(
    http.get(`${API}/x`, () => {
      calls += 1;
      return respond();
    }),
  );
  await createQueryClient()
    .fetchQuery({ queryKey: ['x'], queryFn: () => api('/x'), retryDelay: 0 })
    .catch(() => undefined);
  return calls;
}

test('queries retry twice on server and network errors, never on 4xx', async () => {
  expect(await attempts(() => apiError(500, 'internal', 'Boom.'))).toBe(3);
  expect(await attempts(() => HttpResponse.error())).toBe(3);
  expect(await attempts(() => apiError(404, 'not_found', 'Gone.'))).toBe(1);
  expect(await attempts(() => apiError(429, 'rate_limited', 'Slow down.'))).toBe(1);
});

test('mutations never retry and queries stay fresh for 30 seconds', () => {
  const defaults = createQueryClient().getDefaultOptions();
  expect(defaults.mutations?.retry).toBe(false);
  expect(defaults.queries?.staleTime).toBe(30_000);
});
