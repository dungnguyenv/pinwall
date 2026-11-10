import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, onTestFinished, test } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.ts';

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';
const html = { accept: 'text/html' };

let ctx: TestContext;
let webDir: string;

beforeEach(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'pinwall-web-'));
  await mkdir(join(webDir, 'assets'));
  await writeFile(join(webDir, 'index.html'), INDEX);
  await writeFile(join(webDir, 'assets', 'app.js'), 'console.log("app")');
  await writeFile(join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  ctx = await createTestContext({ env: { PINWALL_WEB_DIR: webDir } });
});

afterEach(async () => {
  await ctx.close();
  await rm(webDir, { recursive: true, force: true });
});

test('spa fallback serves index.html for app routes only', async () => {
  const page = await ctx.request('/projects/x', { headers: html });
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
  expect(page.headers.get('cache-control')).toBe('no-cache');
  expect(await page.text()).toBe(INDEX);

  const asset = await ctx.request('/assets/app.js');
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toContain('javascript');
  expect(asset.headers.get('cache-control')).toContain('immutable');
  expect(await asset.text()).toBe('console.log("app")');

  const api = await ctx.request('/api/v1/x', { headers: html });
  expect(api.status).toBe(404);
  expect(await api.json()).toMatchObject({ error: { code: 'not_found' } });

  const health = await ctx.request('/healthz', { headers: html });
  expect(await health.text()).not.toBe(INDEX);
});

test('the root and other files outside assets are served without a long cache', async () => {
  const root = await ctx.request('/', { headers: html });
  expect(root.status).toBe(200);
  expect(root.headers.get('cache-control')).toBe('no-cache');
  expect(await root.text()).toBe(INDEX);

  const icon = await ctx.request('/favicon.svg');
  expect(icon.status).toBe(200);
  expect(icon.headers.get('content-type')).toContain('image/svg+xml');
  expect(icon.headers.get('cache-control')).toBe('no-cache');
});

test('HEAD answers like GET without a body', async () => {
  const asset = await ctx.request('/assets/app.js', { method: 'HEAD' });
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toContain('immutable');
  expect(await asset.text()).toBe('');

  const page = await ctx.request('/projects/x', { method: 'HEAD', headers: html });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe('');
});

test('a missing asset is a 404, not index.html', async () => {
  const r = await ctx.request('/assets/missing.js', { headers: { accept: '*/*' } });
  expect(r.status).toBe(404);
  expect(r.headers.get('cache-control')).not.toContain('immutable');
});

test('the SPA carries the app security headers', async () => {
  const r = await ctx.request('/projects/x', { headers: html });
  expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(r.headers.get('x-frame-options')).toBe('DENY');
});

test('files outside the web directory are never served', async () => {
  const secret = join(webDir, '..', `outside-${Date.now()}.txt`);
  await writeFile(secret, 'secret');
  onTestFinished(() => rm(secret, { force: true }));
  const name = secret.slice(secret.lastIndexOf('/') + 1);

  for (const path of [`/../${name}`, `/%2e%2e/${name}`, `/assets/%2e%2e/%2e%2e/${name}`]) {
    const r = await ctx.request(path);
    expect(await r.text(), path).not.toBe('secret');
  }
});
