import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppDeps } from '../deps.ts';

export interface MetricsServer {
  /** The port actually bound (the one asked for, or the one the system chose for port 0). */
  port: number;
  /** Stops listening and cuts open connections. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Serves `GET /metrics` on its own port, apart from the app's, so the metrics are never reachable
 * where users are: it listens on `config.listen.host` and `opts.port ?? config.metrics.port`.
 * Resolves to null when `PINWALL_METRICS_PORT` is 0 (metrics off); rejects when the port cannot
 * be bound. Every other request is a plain-text 404.
 */
export async function startMetricsServer(
  deps: AppDeps,
  opts: { port?: number } = {},
): Promise<MetricsServer | null> {
  const { config, metrics, logger } = deps;
  if (config.metrics.port === 0) return null;

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?', 1)[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
      return;
    }
    metrics.registry.metrics().then(
      (page) => {
        res.writeHead(200, { 'Content-Type': metrics.registry.contentType }).end(page);
      },
      (err: unknown) => {
        logger.error({ err }, 'The metrics page could not be built');
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Error\n');
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? config.metrics.port, config.listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Later errors (a socket reset) are the connection's, not the listener's.
  server.on('error', (err) => logger.error({ err }, 'The metrics listener failed'));

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    port,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A scraper's keep-alive connection would hold `close` open for as long as it likes.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
