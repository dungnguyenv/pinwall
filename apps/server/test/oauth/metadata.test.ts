import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, expect, onTestFinished, test } from 'vitest';
import {
  mcpResourceUrl,
  normalizeResource,
  resourceMetadataUrl,
} from '../../src/oauth/metadata.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

const ORIGIN = 'https://pinwall.test';
/** A TLS-terminating proxy forwards to an internal address; the client forged the rest. */
const forged = {
  host: 'internal:8080',
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'http',
};
const PROTECTED_RESOURCE = {
  resource: 'https://pinwall.test/mcp',
  authorization_servers: ['https://pinwall.test'],
  scopes_supported: ['pinwall'],
  bearer_methods_supported: ['header'],
  resource_name: 'Pinwall',
};

let ctx: TestContext;
afterEach(() => ctx?.close());

async function start(env: Record<string, string> = {}): Promise<TestContext> {
  ctx = await createTestContext({
    env: { PINWALL_PUBLIC_ORIGIN: ORIGIN, PINWALL_TRUST_PROXY: 'true', ...env },
  });
  return ctx;
}

test('metadata comes from the public origin behind a proxy', async () => {
  await start();
  const r = await ctx.request('http://internal:8080/.well-known/oauth-authorization-server', {
    headers: forged,
  });
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('application/json');
  const body = await r.json();
  expect(body).toEqual({
    issuer: 'https://pinwall.test',
    authorization_endpoint: 'https://pinwall.test/oauth/authorize',
    token_endpoint: 'https://pinwall.test/oauth/token',
    registration_endpoint: 'https://pinwall.test/oauth/register',
    revocation_endpoint: 'https://pinwall.test/oauth/revoke',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['pinwall'],
    authorization_response_iss_parameter_supported: true,
  });
  expect(OAuthMetadataSchema.safeParse(body).success).toBe(true);
  expect(mcpResourceUrl(ctx.deps.config)).toBe('https://pinwall.test/mcp');
  expect(resourceMetadataUrl(ctx.deps.config)).toBe(
    'https://pinwall.test/.well-known/oauth-protected-resource/mcp',
  );
});

test('protected resource metadata is served at both paths', async () => {
  await start();
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const r = await ctx.request(`http://internal:8080${path}`, { headers: forged });
    expect(r.status, path).toBe(200);
    const body = await r.json();
    expect(body, path).toEqual(PROTECTED_RESOURCE);
    expect(OAuthProtectedResourceMetadataSchema.safeParse(body).success, path).toBe(true);
  }
});

test('metadata is JSON for browsers too', async () => {
  const webDir = await mkdtemp(join(tmpdir(), 'pinwall-web-'));
  onTestFinished(() => rm(webDir, { recursive: true, force: true }));
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  await start({ PINWALL_WEB_DIR: webDir });
  const html = { accept: 'text/html,application/xhtml+xml' };

  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const r = await ctx.request(path, { headers: html });
    expect(r.status, path).toBe(200);
    expect(r.headers.get('content-type'), path).toContain('application/json');
  }
  // Other well-known paths are not app pages either.
  const missing = await ctx.request('/.well-known/openid-configuration', { headers: html });
  expect(missing.status).toBe(404);
  expect(missing.headers.get('content-type')).toContain('application/json');
});

test('normalizeResource', () => {
  expect(normalizeResource('http://LOCALHOST:8080/mcp/')).toBe('http://localhost:8080/mcp');
  expect(normalizeResource('https://pinwall.test:443/mcp')).toBe('https://pinwall.test/mcp');
  expect(normalizeResource('https://pinwall.test/mcp')).toBe('https://pinwall.test/mcp');
  expect(normalizeResource('https://pinwall.test/')).toBe('https://pinwall.test');
  for (const bad of [
    'https://pinwall.test/mcp?x=1',
    'https://pinwall.test/mcp?',
    'https://pinwall.test/mcp#f',
    'https://pinwall.test/mcp#',
    'not a url',
    'urn:pinwall:mcp',
  ]) {
    expect(normalizeResource(bad), bad).toBeNull();
  }
});
