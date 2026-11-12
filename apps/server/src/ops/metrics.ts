import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config/types.ts';
import { contentHostToken } from '../content/routes.ts';
import type { DbHandle } from '../db/connect.ts';
import type { Scheduler } from '../infra/index.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError } from '../lib/errors.ts';
import { PINWALL_VERSION } from '../version.ts';

/**
 * What this process counts, in a registry of its own. Names start with `pinwall_`; labels hold
 * only values from a fixed, small set (a method, a route pattern, a status, a version source, a
 * job name, a refusal reason), never a token, an id, an email, a host name or a raw path.
 */
export interface Metrics {
  registry: Registry;
  /** `pinwall_http_requests_total`: one per response, by the route that answered. */
  httpRequests: Counter<'method' | 'route' | 'status'>;
  /** `pinwall_http_request_duration_seconds`: until the handler returns, not until a stream ends. */
  httpDuration: Histogram<'method' | 'route'>;
  /** `pinwall_publishes_total`: versions committed, by `versions.source`. */
  publishes: Counter<'source'>;
  /** `pinwall_upload_bytes_total`: request bytes ingest read, whether or not it accepted them. */
  uploadBytes: Counter<'source'>;
  /** `pinwall_uploads_rejected_total`: publishes refused with a 4xx, by `rejectionReason`. */
  uploadsRejected: Counter<'reason'>;
  /** `pinwall_job_runs_total`: scheduled job runs, `outcome` being `ok` or `error`. */
  jobRuns: Counter<'job' | 'outcome'>;
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Methods that get their own series; any other (a scanner's) shares `OTHER`. */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Builds the registry. The gauges that describe stored data (`pinwall_active_sessions`,
 * `pinwall_storage_blobs`, `pinwall_storage_blob_bytes`) are read from the database when the
 * page is scraped; if that fails, they keep the values of the last scrape that worked, so one
 * bad moment never fails the whole scrape. `pinwall_build_info` carries the version.
 */
export function createMetrics(h: DbHandle, clock: Clock): Metrics {
  const registry = new Registry();
  const registers = [registry];

  const httpRequests = new Counter({
    name: 'pinwall_http_requests_total',
    help: 'HTTP responses by method, route pattern and status.',
    labelNames: ['method', 'route', 'status'] as const,
    registers,
  });
  const httpDuration = new Histogram({
    name: 'pinwall_http_request_duration_seconds',
    help: 'Seconds until the handler returned, by method and route pattern.',
    labelNames: ['method', 'route'] as const,
    buckets: DURATION_BUCKETS,
    registers,
  });
  const publishes = new Counter({
    name: 'pinwall_publishes_total',
    help: 'Versions committed, by source.',
    labelNames: ['source'] as const,
    registers,
  });
  const uploadBytes = new Counter({
    name: 'pinwall_upload_bytes_total',
    help: 'Request bytes read by publishing, accepted or not, by source.',
    labelNames: ['source'] as const,
    registers,
  });
  const uploadsRejected = new Counter({
    name: 'pinwall_uploads_rejected_total',
    help: 'Publishes refused as a client error, by reason.',
    labelNames: ['reason'] as const,
    registers,
  });
  const jobRuns = new Counter({
    name: 'pinwall_job_runs_total',
    help: 'Scheduled job runs, by job and outcome.',
    labelNames: ['job', 'outcome'] as const,
    registers,
  });

  new Gauge({
    name: 'pinwall_build_info',
    help: 'Always 1; the version label tells which Pinwall this is.',
    labelNames: ['version'] as const,
    registers,
  }).set({ version: PINWALL_VERSION }, 1);

  /** Sets a gauge from the database at scrape time; on failure the last value stays. */
  const stored = (name: string, help: string, read: () => Promise<number>) =>
    new Gauge({
      name,
      help,
      registers,
      async collect() {
        try {
          this.set(await read());
        } catch {
          // Keep the previous value: the readiness probe is where a dead database shows.
        }
      },
    });

  stored('pinwall_active_sessions', 'Sessions that have not expired.', async () => {
    const row = await h.db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .where('expires_at', '>', clock.now())
      .executeTakeFirstOrThrow();
    return Number(row.n);
  });

  // One query serves both blob gauges when they are collected together, as a scrape does.
  let blobTotals: Promise<{ count: number; bytes: number }> | null = null;
  const readBlobTotals = () => {
    blobTotals ??= h.db
      .selectFrom('blobs')
      .select((eb) => [
        eb.fn.countAll<number | string>().as('n'),
        eb.fn.sum<number | string | null>('size').as('bytes'),
      ])
      .executeTakeFirstOrThrow()
      // The sum is a numeric (a string) on Postgres, and null when there are no rows.
      .then((row) => ({ count: Number(row.n), bytes: Number(row.bytes ?? 0) }))
      .finally(() => {
        blobTotals = null;
      });
    return blobTotals;
  };
  stored('pinwall_storage_blobs', 'Stored blobs.', async () => (await readBlobTotals()).count);
  stored(
    'pinwall_storage_blob_bytes',
    'Total size of the stored blobs in bytes.',
    async () => (await readBlobTotals()).bytes,
  );

  return { registry, httpRequests, httpDuration, publishes, uploadBytes, uploadsRejected, jobRuns };
}

/** Adds Node's process metrics (CPU, memory, event loop, GC) to `m`. The server does this once. */
export function enableProcessMetrics(m: Metrics): void {
  collectDefaultMetrics({ register: m.registry });
}

/**
 * The label for the route that answered `c`, once the response exists. Never the raw path:
 * 1. a host under the content host (content-domain mode) is `content`;
 * 2. else the pattern of the route that responded, such as `/api/v1/artifacts/:id`;
 * 3. a catch-all (`*`, `/*`) or no route at all is `spa` for a success (the web app answered)
 *    and `unmatched` for an error, so every path nobody serves shares one series.
 */
export function routeLabel(c: Context, config: Config): string {
  if (
    config.isolation.mode === 'content-domain' &&
    contentHostToken(config, new URL(c.req.url).hostname) !== null
  ) {
    return 'content';
  }
  const pattern = matchedRoutes(c)[c.req.routeIndex]?.path;
  if (pattern === undefined || pattern === '*' || pattern === '/*') {
    return c.res.status < 400 ? 'spa' : 'unmatched';
  }
  return pattern;
}

/** Counts every response and times its handler, by method, route pattern and status. */
export function httpMetrics(m: Metrics, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const method = METHODS.has(c.req.method) ? c.req.method : 'OTHER';
    const route = routeLabel(c, config);
    m.httpRequests.inc({ method, route, status: String(c.res.status) });
    m.httpDuration.observe({ method, route }, (performance.now() - started) / 1000);
  };
}

const REASON = /^[a-z_]{1,40}$/;

/**
 * Why a publish was refused, as a label value: for a client error (an `AppError` with a 4xx
 * status) the `limit` or `reason` its details name, else its error code, and `other` when that
 * is not a short snake_case word. Null for anything else (a server fault is not a refusal).
 */
export function rejectionReason(err: unknown): string | null {
  if (!(err instanceof AppError) || err.status < 400 || err.status > 499) return null;
  const reason = String(err.details?.limit ?? err.details?.reason ?? err.code);
  return REASON.test(reason) ? reason : 'other';
}

/** `s`, with every job it runs counted as `ok` or `error` (the error is rethrown unchanged). */
export function instrumentScheduler(s: Scheduler, m: Metrics): Scheduler {
  return {
    every: (name, intervalMs, fn) =>
      s.every(name, intervalMs, async () => {
        try {
          await fn();
        } catch (err) {
          m.jobRuns.inc({ job: name, outcome: 'error' });
          throw err;
        }
        m.jobRuns.inc({ job: name, outcome: 'ok' });
      }),
    stop: () => s.stop(),
  };
}
