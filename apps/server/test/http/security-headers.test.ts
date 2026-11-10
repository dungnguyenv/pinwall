import { afterEach, expect, test } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.close());

async function open(env?: Record<string, string>) {
  ctx = await createTestContext(env ? { env } : {});
  return ctx;
}

test('app pages carry the security headers', async () => {
  const { request } = await open();
  const r = await request('/healthz');
  expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(r.headers.get('content-security-policy')).toContain("frame-src 'self'");
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('strict-transport-security')).toBeNull(); // http origin
});

test('the app policy is exactly the one in the security model', async () => {
  const { request } = await open();
  const r = await request('/healthz');
  expect(r.headers.get('content-security-policy')).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  expect(r.headers.get('x-frame-options')).toBe('DENY');
  expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
});

test('content-domain mode allows framing the content host', async () => {
  const { request } = await open({
    PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test',
    PINWALL_ISOLATION: 'content-domain',
    PINWALL_CONTENT_ORIGIN: 'https://pw-content.test:8443',
  });
  const r = await request('/healthz');
  const csp = r.headers.get('content-security-policy');
  expect(csp).toContain('frame-src https://*.pw-content.test:8443;');
  expect(csp).not.toContain("frame-src 'self'");
  expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000');
});

test('error responses carry the headers too', async () => {
  const { request } = await open();
  for (const accept of ['text/html', 'application/json']) {
    const r = await request('/definitely/not/here', { headers: { accept } });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  }
});

test('a header a route sets on purpose is kept', async () => {
  const { app, request } = await open();
  app.get('/picture', (c) =>
    c.body('png', 200, { 'content-security-policy': "default-src 'none'; sandbox" }),
  );
  const r = await request('/picture');
  expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
});
