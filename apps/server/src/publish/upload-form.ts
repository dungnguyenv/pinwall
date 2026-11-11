import { PassThrough, pipeline, type Readable } from 'node:stream';
import busboy from 'busboy';
import { AppError, badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/** A web upload's fields are a target, a message and paths: all far below this. */
const FIELD_MAX_BYTES = 65_536;

/** One part of a web upload's form, in the order it arrived. */
export type FormPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; body: Readable };

export interface FormReader {
  /**
   * The next part, or null once the form has ended. A file part's `body` must be read to its end
   * (or drained with `resume()`) before the next call: the rest of the request waits until then,
   * so a form never holds more than the part being read.
   */
  next(): Promise<FormPart | null>;
  /** Stops reading: destroys the request body and the file part being read. */
  destroy(): void;
}

/** The 400 for a body that is not the form a web upload sends. */
export function uploadFormError(): AppError {
  return badRequest(t('publish.upload.form'));
}

/**
 * Reads `body` as `multipart/form-data` part by part while it arrives, never as a whole.
 * `contentType` is the request's, boundary included. File names are read as UTF-8 and keep any
 * folders they name. A failure reaches `next()` and the file part being read: an `AppError` from
 * `body` (a limit it crossed) as it is, anything wrong with the form itself, a field value over
 * 64 KiB included, as `uploadFormError()`.
 */
export function readUploadForm(body: Readable, contentType: string): FormReader {
  // busboy also reads urlencoded forms, which carry no files.
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    body.destroy();
    throw uploadFormError();
  }
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { 'content-type': contentType },
      defParamCharset: 'utf8',
      preservePath: true,
      limits: { fieldSize: FIELD_MAX_BYTES },
    });
  } catch {
    // No boundary.
    body.destroy();
    throw uploadFormError();
  }

  const queue: FormPart[] = [];
  let ended = false;
  let failure: AppError | null = null;
  let waiting: { resolve(part: FormPart | null): void; reject(error: AppError): void } | null =
    null;

  const push = (part: FormPart) => {
    if (waiting === null) {
      queue.push(part);
      return;
    }
    const { resolve } = waiting;
    waiting = null;
    resolve(part);
  };
  const fail = (error: AppError) => {
    failure ??= error;
    if (waiting === null) return;
    const { reject } = waiting;
    waiting = null;
    reject(failure);
  };

  parser.on('field', (name, value, info) => {
    if (info.nameTruncated || info.valueTruncated) fail(uploadFormError());
    else push({ kind: 'field', name, value });
  });
  parser.on('file', (name, stream, info) => {
    // An `application/octet-stream` part may come without a filename: it has an empty one.
    push({ kind: 'file', name, filename: info.filename ?? '', body: formFile(stream) });
  });
  // busboy finishes only once every file part has been read to its end.
  pipeline(body, parser, (error) => {
    if (error) {
      fail(asFormError(error));
      return;
    }
    ended = true;
    if (waiting === null) return;
    const { resolve } = waiting;
    waiting = null;
    resolve(null);
  });

  return {
    next() {
      if (failure !== null) return Promise.reject(failure);
      const part = queue.shift();
      if (part !== undefined) return Promise.resolve(part);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    destroy() {
      body.destroy();
      parser.destroy();
    },
  };
}

/** What a reader of the form is told when reading failed. */
function asFormError(error: unknown): AppError {
  return error instanceof AppError ? error : uploadFormError();
}

/**
 * busboy's stream of one file part, as its reader sees it: the same bytes, failing with
 * `asFormError` of whatever broke it, so a truncated form reads as a bad form, not a server error.
 */
function formFile(stream: Readable): Readable {
  const file = new PassThrough();
  // A part whose reader already gave up (the upload failed elsewhere) is destroyed with no one
  // listening; a reader still reading gets the error through its own listener.
  file.on('error', () => {});
  stream.on('error', (error) => file.destroy(asFormError(error)));
  stream.pipe(file);
  return file;
}
