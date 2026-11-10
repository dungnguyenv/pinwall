import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.ts';

interface OpenApiDoc {
  openapi: string;
  info: { title: string };
  servers: { url: string }[];
  paths: Record<string, unknown>;
  components: { securitySchemes: Record<string, unknown> };
}

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({ env: { PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' } });
});
afterEach(() => ctx.close());

test('openapi document uses the public origin', async () => {
  const r = await ctx.request('http://internal:8080/api/v1/openapi.json', {
    headers: { host: 'internal:8080', 'x-forwarded-host': 'evil.example' },
  });
  expect(r.status).toBe(200);
  const doc = (await r.json()) as OpenApiDoc;
  expect(doc.openapi).toBe('3.1.0');
  expect(doc.info.title).toBe('Pinwall API');
  expect(doc.servers).toEqual([{ url: 'https://pinwall.test/api/v1' }]);
  expect(Object.keys(doc.paths)).toContain('/config/public');
});

test('openapi document declares the bearer and session security schemes', async () => {
  const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as OpenApiDoc;
  expect(doc.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
  expect(doc.components.securitySchemes.session).toMatchObject({
    type: 'apiKey',
    in: 'cookie',
    name: 'pinwall_session',
    description: expect.stringContaining('__Host-pinwall_session'),
  });
});
