import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/app.ts';
import type { Config } from '../../src/config/types.ts';
import { configureServerForUploads } from '../../src/publish/upload-route.ts';

/**
 * Serves `app` on an ephemeral port of the loopback interface, with the server set up for
 * uploads as `pinwall serve` sets it up.
 */
export async function listen(
  app: Hono<AppEnv>,
  config: Config,
): Promise<{ port: number; server: Server; close(): Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
    configureServerForUploads(s, config);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface SocketReply {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
  /** Whether the server sent `100 Continue`. */
  continued: boolean;
}

/**
 * POSTs to `path` with `node:http`, as curl does: the body goes out in `chunks` (chunked unless a
 * Content-Length is given), after `100 Continue` when `Expect` asks for it. `stall` sends the
 * chunks and then neither ends nor closes the request. Resolves once the whole response body
 * has arrived; a reset after that does not matter, one before it fails the call.
 */
export function socketPost(
  port: number,
  path: string,
  o: { headers: Record<string, string>; chunks: Buffer[]; gapMs?: number; stall?: boolean },
): Promise<SocketReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: o.headers });
    let answered = false;
    let continued = false;
    req.on('continue', () => {
      continued = true;
    });
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => {
        answered = true;
        const text = Buffer.concat(parts).toString('utf8');
        const json: unknown = JSON.parse(text);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, continued });
        req.destroy();
      });
      res.on('error', reject);
    });
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    const send = async () => {
      for (const chunk of o.chunks) {
        if (req.destroyed) return;
        req.write(chunk);
        if (o.gapMs) await new Promise((r) => setTimeout(r, o.gapMs));
      }
      if (!o.stall && !req.destroyed) req.end();
    };
    if (o.headers.expect === '100-continue') req.on('continue', () => void send());
    else void send();
  });
}

/** `buf` cut into `n` chunks of about the same size. */
export function split(buf: Buffer, n: number): Buffer[] {
  const size = Math.ceil(buf.length / n);
  const chunks: Buffer[] = [];
  for (let start = 0; start < buf.length; start += size) {
    chunks.push(buf.subarray(start, start + size));
  }
  return chunks;
}
