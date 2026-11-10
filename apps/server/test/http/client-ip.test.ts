import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, onTestFinished, test } from 'vitest';
import type { Config } from '../../src/config/types.ts';
import { clientIp } from '../../src/http/client-ip.ts';

/** Asks an app that answers with `clientIp`, as if the request came from `socket`. */
async function ipOf(
  trustProxy: Config['trustProxy'],
  socket: string | undefined,
  forwardedFor?: string,
): Promise<string> {
  const app = new Hono();
  app.get('/ip', (c) => c.text(clientIp(c, trustProxy)));
  const headers: Record<string, string> = forwardedFor ? { 'x-forwarded-for': forwardedFor } : {};
  // The same bindings the Node adapter passes as `c.env`.
  const env =
    socket === undefined ? undefined : { incoming: { socket: { remoteAddress: socket } } };
  return (await app.request('/ip', { headers }, env)).text();
}

test('client ip uses X-Forwarded-For only when trusted', async () => {
  expect(await ipOf(false, '10.0.0.5', '203.0.113.7')).toBe('10.0.0.5');
  expect(await ipOf(['10.0.0.0/8'], '10.0.0.5', '203.0.113.7')).toBe('203.0.113.7');
});

test('a socket outside the trusted ranges is the client, whatever it forwards', async () => {
  expect(await ipOf(['10.0.0.0/8'], '198.51.100.9', '203.0.113.7')).toBe('198.51.100.9');
});

test('entries a client sent ahead of the trusted proxies are ignored', async () => {
  // The client spoofs 1.1.1.1; the proxy chain appended 203.0.113.7 and 10.0.0.9.
  expect(await ipOf(['10.0.0.0/8'], '10.0.0.5', '1.1.1.1, 203.0.113.7, 10.0.0.9')).toBe(
    '203.0.113.7',
  );
  expect(await ipOf(['10.0.0.5', '10.0.0.9'], '10.0.0.5', '1.1.1.1, 203.0.113.7, 10.0.0.9')).toBe(
    '203.0.113.7',
  );
  // A spoofed entry inside a trusted range is still left of the real client.
  expect(await ipOf(['10.0.0.0/8'], '10.0.0.5', '10.0.0.66, 203.0.113.7')).toBe('203.0.113.7');
  // With `true` the one proxy appended 203.0.113.7; whatever the client sent is to its left.
  expect(await ipOf(true, '10.0.0.5', '1.1.1.1, 203.0.113.7')).toBe('203.0.113.7');
  expect(await ipOf(true, '10.0.0.5', '10.0.0.66, 1.1.1.1, 203.0.113.7')).toBe('203.0.113.7');
});

test('true trusts exactly one proxy: the right-most entry is the client', async () => {
  // Only the socket peer is trusted, so the address it appended is the client, even a private one.
  expect(await ipOf(true, '10.0.0.5', '203.0.113.7, 10.0.0.9')).toBe('10.0.0.9');
  expect(await ipOf(true, '10.0.0.5', '203.0.113.7')).toBe('203.0.113.7');
  expect(await ipOf(true, '10.0.0.5')).toBe('10.0.0.5');
});

test('an entry that is not an address stops the walk at the hop before it', async () => {
  expect(await ipOf(['10.0.0.0/8'], '10.0.0.5', 'garbage, 10.0.0.9')).toBe('10.0.0.9');
  expect(await ipOf(true, '10.0.0.5', '203.0.113.7, unknown')).toBe('10.0.0.5');
});

test('IPv4-mapped IPv6 addresses match IPv4 ranges and are reported as IPv4', async () => {
  expect(await ipOf(false, '::ffff:10.0.0.5')).toBe('10.0.0.5');
  expect(await ipOf(['10.0.0.0/8'], '::ffff:10.0.0.5', '203.0.113.7')).toBe('203.0.113.7');
  expect(await ipOf(['fd00::/8'], 'fd00::1', '2001:db8::7')).toBe('2001:db8::7');
});

test('without a socket the client is unknown', async () => {
  expect(await ipOf(['10.0.0.0/8'], undefined, '203.0.113.7')).toBe('unknown');
});

test('reads the socket address of a real connection', async () => {
  const app = new Hono();
  app.get('/ip', (c) => c.text(clientIp(c, ['127.0.0.0/8'])));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  const direct = await fetch(`http://127.0.0.1:${port}/ip`);
  expect(await direct.text()).toBe('127.0.0.1');
  const proxied = await fetch(`http://127.0.0.1:${port}/ip`, {
    headers: { 'x-forwarded-for': '203.0.113.7' },
  });
  expect(await proxied.text()).toBe('203.0.113.7');
});
