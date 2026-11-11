import { expect, test } from 'vitest';
import {
  checkRedirectUri,
  isLoopbackHost,
  matchRedirectUri,
  type RedirectUriProblem,
  redirectHost,
} from '../../src/oauth/redirect-uris.ts';

test('checkRedirectUri accepts and refuses', () => {
  for (const ok of [
    'http://127.0.0.1:33418/callback',
    'http://localhost/cb',
    'http://[::1]:5000/cb',
    'https://app.example/cb?x=1',
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'com.example.app:/oauth2redirect',
    `https://a.example/${'x'.repeat(2030)}`,
  ]) {
    expect(checkRedirectUri(ok), ok).toEqual({ ok: true });
  }
  const refused: [string, RedirectUriProblem][] = [
    ['http://evil.example/cb', 'insecure_http'],
    ['http://127.0.0.1.evil.example/cb', 'insecure_http'],
    ['http://localhost.evil.example/cb', 'insecure_http'],
    ['https://a.example/cb#x', 'fragment'],
    ['https://a.example/cb#', 'fragment'],
    ['https://u:p@a.example/cb', 'userinfo'],
    ['https://u@a.example/cb', 'userinfo'],
    ['javascript:alert(1)', 'forbidden_scheme'],
    ['JavaScript:alert(1)', 'forbidden_scheme'],
    ['data:text/html,x', 'forbidden_scheme'],
    ['file:///etc/passwd', 'forbidden_scheme'],
    ['vbscript:x', 'forbidden_scheme'],
    ['blob:https://a.example/x', 'forbidden_scheme'],
    ['about:blank', 'forbidden_scheme'],
    ['wss://a.example/cb', 'forbidden_scheme'],
    ['not a url', 'not_a_url'],
    ['/relative/cb', 'not_a_url'],
    // The URL parser drops tabs, newlines and outer spaces; a redirect URI must not rely on that.
    ['java\nscript:alert(1)', 'not_a_url'],
    [' https://a.example/cb', 'not_a_url'],
    ['https://a.example/c\tb', 'not_a_url'],
    [`https://a.example/${'x'.repeat(2031)}`, 'too_long'],
  ];
  for (const [uri, problem] of refused) {
    expect(checkRedirectUri(uri), uri).toEqual({ ok: false, problem });
  }
});

test('loopback redirects match on any port, everything else exactly', () => {
  const reg = ['http://127.0.0.1:33418/callback', 'https://app.example/cb'];
  expect(matchRedirectUri(reg, 'http://127.0.0.1:33418/callback')).toBe(true);
  expect(matchRedirectUri(reg, 'http://127.0.0.1:50999/callback')).toBe(true);
  expect(matchRedirectUri(reg, 'http://127.0.0.1/callback')).toBe(true);
  expect(matchRedirectUri(reg, 'https://app.example/cb')).toBe(true);
  for (const no of [
    'http://127.0.0.1:50999/other',
    'http://localhost:33418/callback',
    'http://127.0.0.1:50999/callback?x=1',
    'http://127.0.0.1:50999/callback#x',
    'http://u@127.0.0.1:50999/callback',
    'https://127.0.0.1:33418/callback',
    'https://app.example/cb?x',
    'https://app.example:443/cb',
    'https://app.example/cb/',
    'https://app.example/CB',
    'not a url',
  ]) {
    expect(matchRedirectUri(reg, no), no).toBe(false);
  }
  // A loopback query is part of the match.
  expect(matchRedirectUri(['http://localhost:1/cb?a=1'], 'http://localhost:2/cb?a=1')).toBe(true);
  expect(matchRedirectUri(['http://localhost:1/cb?a=1'], 'http://localhost:2/cb?a=2')).toBe(false);
  // Any other registered URI never matches another port.
  expect(matchRedirectUri(['https://app.example:8443/cb'], 'https://app.example:9443/cb')).toBe(
    false,
  );
  expect(matchRedirectUri([], 'http://127.0.0.1:1/callback')).toBe(false);
});

test('redirectHost names where the browser goes back to', () => {
  expect(redirectHost('http://localhost:33418/callback')).toBe('localhost:33418');
  expect(redirectHost('https://app.example/cb?x=1')).toBe('app.example');
  expect(redirectHost('cursor://anysphere.cursor-mcp/oauth/callback')).toBe(
    'cursor://anysphere.cursor-mcp',
  );
  expect(redirectHost('com.example.app:/oauth2redirect')).toBe('com.example.app:');
});

test('isLoopbackHost knows the three loopback names', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
  for (const host of ['127.0.0.2', 'localhost.', '::1', 'example.com', '']) {
    expect(isLoopbackHost(host), host).toBe(false);
  }
});
