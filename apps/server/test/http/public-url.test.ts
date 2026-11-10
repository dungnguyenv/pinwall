import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { publicUrl } from '../../src/http/public-url.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.close());

test('public url ignores Host and forwarded headers', async () => {
  ctx = await createTestContext({
    env: { PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test', PINWALL_TRUST_PROXY: 'true' },
  });
  ctx.app.get('/where', (c) => c.text(publicUrl(c.var.deps.config, '/x')));

  // What the Node adapter builds from a request that reached it as Host: internal:8080.
  const r = await ctx.request('http://internal:8080/where', {
    headers: {
      host: 'internal:8080',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
    },
  });
  expect(await r.text()).toBe('https://pinwall.test/x');
});

test('public url keeps the path, query and fragment it is given', () => {
  const config = loadConfig({ PINWALL_PUBLIC_ORIGIN: 'http://localhost:8080' });
  expect(publicUrl(config, '/')).toBe('http://localhost:8080/');
  expect(publicUrl(config, '/setup?token=abc#top')).toBe(
    'http://localhost:8080/setup?token=abc#top',
  );
});

test('public url never leaves the public origin', () => {
  const config = loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
  // A path that a URL parser would read as another host is rejected, not resolved.
  for (const path of ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'x', '']) {
    expect(() => publicUrl(config, path), path).toThrow(TypeError);
  }
});
