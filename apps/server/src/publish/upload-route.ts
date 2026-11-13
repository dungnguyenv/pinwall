import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config/types.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { runUpload } from './sessions.ts';

/** An upload that sends nothing for this long while Pinwall waits for its body is ended. */
export const UPLOAD_IDLE_TIMEOUT_MS = 60_000;

/** A client gets this long to send a request's headers. */
const HEADERS_TIMEOUT_MS = 60_000;

/**
 * Sets the Node server up for uploads; `pinwall serve` calls it before the server takes requests.
 *
 * - No deadline for a whole request. Node's default of 300 s would cut an upload of 95 MB (the default limit) sent
 *   slower than about 2.5 Mbit/s; the upload route ends a body that stalls for
 *   `UPLOAD_IDLE_TIMEOUT_MS` instead. Headers must still arrive within 60 s.
 * - A request that asks for `100 Continue` and declares a `Content-Length` over
 *   `PINWALL_MAX_UPLOAD_BYTES` is not asked for its body: the routes refuse such a length
 *   before reading (413), so the client learns why without sending a byte of it. Node closes the
 *   connection after that answer, since the client may yet send the body unasked.
 */
export function configureServerForUploads(server: Server, config: Config): void {
  server.requestTimeout = 0;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  const max = config.limits.maxUploadBytes;
  // With a listener, Node no longer sends `100 Continue` by itself, nor emits `request`.
  server.on('checkContinue', (req, res) => {
    const length = declaredLength(req.headers['content-length']);
    if (length === null || length <= max) res.writeContinue();
    server.emit('request', req, res);
  });
}

/**
 * `POST /upload/:token`: the one-time upload URL. The token in the path is the only credential:
 * the route reads neither cookies nor `Authorization`, and sets no cookie. The body streams into
 * the publish as it arrives; `?filename=` names a single file. Errors are JSON (`wantsHtml`
 * leaves `/upload/` out).
 *
 * A refused upload stops reading its body at once (destroy, not drain): the error response goes
 * out right away, and a client that is still sending learns why (curl stops sending on an early
 * error status). Draining would read up to the upload limit of unwanted bytes per refusal. The
 * connection stays open for 500 ms after the response (`@hono/node-server`'s cleanup of unread
 * request bodies) and is closed after that, so the response reaches the client before the
 * close: the staged close of RFC 9112 §9.6. No `Connection: close` is sent, since Node would then
 * close the socket the moment the response is written, with request bytes unread, and the reset
 * that follows can erase the response before the client reads it.
 */
export function mountUploadRoute(app: Hono<AppEnv>, opts: { idleTimeoutMs?: number } = {}): void {
  const idleMs = opts.idleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS;
  app.post('/upload/:token', async (c) => {
    const raw = c.req.raw;
    const source = raw.body === null ? Readable.from([]) : Readable.fromWeb(raw.body);
    const body = withIdleTimeout(source, idleMs);
    const result = await runUpload(c.var.deps, c.req.param('token'), {
      body,
      contentType: c.req.header('content-type') ?? null,
      contentLength: declaredLength(c.req.header('content-length')),
      filename: c.req.query('filename') ?? null,
    });
    return c.json(result, 201, { 'Cache-Control': 'no-store' });
  });
}

/** The 408 for an upload that sent nothing for `ms`. */
function uploadIdle(ms: number): AppError {
  const seconds = Math.ceil(ms / 1000);
  return new AppError('request_timeout', 408, t('publish.upload.idle', { seconds }), {
    idle_timeout_seconds: seconds,
  });
}

/** The 400 for an upload whose body broke off before its end: the client went away. */
function uploadInterrupted(): AppError {
  return badRequest(t('publish.upload.interrupted'));
}

/** `Content-Length` as a number, or null when it is absent or not a plain byte count. */
export function declaredLength(header: string | undefined): number | null {
  if (header === undefined || !/^\d+$/.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * `source`, an upload's body, as a stream that fails with the 408 `request_timeout` once no byte
 * has arrived for `ms` while its reader is waiting for one, and with a 400 when `source` fails or
 * closes before its end (the client went away). Its failures are therefore always `AppError`s,
 * so whatever reads it (sniffing, an archive, a file being staged) answers 4xx, never 500. Time
 * the reader spends on bytes it already has does not count, so a slow store or database cannot
 * make a steady client time out. Destroying the result destroys `source`.
 */
export function withIdleTimeout(source: Readable, ms: number): Readable {
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => guarded.destroy(uploadIdle(ms)), ms);
  };

  const guarded = new Readable({
    read() {
      arm();
      source.resume();
    },
    destroy(error, callback) {
      disarm();
      source.destroy();
      callback(error);
    },
  });
  // The upload awaits its session, its user and its target before anything reads the body. A
  // client that goes away meanwhile fails `guarded` with no reader listening, and an `error` no
  // one listens for is an uncaught exception, which ends the process. This listener keeps it
  // handled; whoever reads later (`pipeline`, async iteration, `peek`) attaches its own and still
  // gets the error, as a destroyed stream reports it to every new reader.
  guarded.on('error', () => {});

  source.on('data', (chunk: Buffer) => {
    if (guarded.push(chunk)) {
      arm();
    } else {
      // The reader is busy with what it has; waiting on it is not the client being idle.
      disarm();
      source.pause();
    }
  });
  source.on('end', () => {
    ended = true;
    disarm();
    guarded.push(null);
  });
  source.on('error', (error) => {
    guarded.destroy(error instanceof AppError ? error : uploadInterrupted());
  });
  source.on('close', () => {
    if (!ended) guarded.destroy(uploadInterrupted());
  });
  source.pause();
  return guarded;
}
