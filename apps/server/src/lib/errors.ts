export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'version_conflict'
  | 'gone'
  | 'request_timeout'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'upload_session_used'
  | 'upload_session_expired'
  | 'setup_required'
  | 'setup_done'
  | 'invalid_credentials'
  | 'access_denied'
  | 'internal';

export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError('bad_request', 400, message, details);

export const unauthorized = (message: string, details?: Record<string, unknown>) =>
  new AppError('unauthorized', 401, message, details);

export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new AppError('forbidden', 403, message, details);

export const notFound = (message: string, details?: Record<string, unknown>) =>
  new AppError('not_found', 404, message, details);

/** The caller sets the `Allow` header before throwing it. */
export const methodNotAllowed = (message: string) =>
  new AppError('method_not_allowed', 405, message);

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('conflict', 409, message, details);

export const gone = (message: string, details?: Record<string, unknown>) =>
  new AppError('gone', 410, message, details);

export const payloadTooLarge = (message: string, details?: Record<string, unknown>) =>
  new AppError('payload_too_large', 413, message, details);

export const unsupportedMediaType = (message: string, details?: Record<string, unknown>) =>
  new AppError('unsupported_media_type', 415, message, details);

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError('rate_limited', 429, `Too many requests. Retry in ${retryAfterSeconds} seconds.`, {
    retry_after_seconds: retryAfterSeconds,
  });
