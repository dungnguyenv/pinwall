import type { TFunction } from 'i18next';
import type { z } from 'zod';
import i18n from '../i18n.ts';
import { ErrorBody } from './dto.ts';

const API_BASE = '/api/v1';

/**
 * A request that did not produce what the caller asked for.
 *
 * `code` is the server's error code when the server sent a Pinwall error body.
 * Otherwise it says what went wrong on the way: `network` (status 0: no
 * response at all), `invalid_response` (a success the schema rejects) or
 * `http_<status>` (an error page from something in front of Pinwall, such as
 * a proxy). Only server errors carry a `message`; the others leave it empty
 * so `errorMessage()` picks an English one.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON. */
  body?: unknown;
  query?: Query;
  /** Extra request headers, such as a share-link guest's edit token. The JSON content type and `accept` win. */
  headers?: Record<string, string>;
  /** Parses the success body. Without one the body is ignored and the call resolves undefined. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
  /** Whether a 401 `unauthorized` ends the session in the app. Default true. */
  redirectOn401?: boolean;
}

/** The absolute URL of an API path on this origin. `null` and `undefined` query values are left out. */
export function apiUrl(path: string, query?: Query): string {
  const url = new URL(API_BASE + path, location.origin);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
  }
  return url.href;
}

/**
 * Calls the Pinwall API with the browser session. Rejects with an `ApiError`
 * for every failure except an abort through `signal`, which rejects with the
 * abort itself so callers can tell cancelling from failing.
 */
export async function api<T = void>(path: string, o: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, query, schema, signal, redirectOn401 = true } = o;
  const headers: Record<string, string> = { ...o.headers, accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(apiUrl(path, query), init);
    // Read the body only when something uses it: an error body or a schema.
    text = !response.ok || schema ? await response.text() : '';
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw withCause(new ApiError(0, 'network', ''), cause);
  }

  if (!response.ok) {
    const error = errorFromBody(response.status, text);
    notifyUnauthorized(error, redirectOn401);
    throw error;
  }
  if (!schema) return undefined as T;

  const parsed = schema.safeParse(parseJson(text));
  if (!parsed.success) {
    throw withCause(new ApiError(response.status, 'invalid_response', ''), parsed.error);
  }
  return parsed.data;
}

/**
 * The error for a failed response, from its status and body text. A Pinwall
 * error body gives the server's code, message and details; anything else (an
 * HTML error page, an empty body) gives `http_<status>` and no message.
 */
export function errorFromBody(status: number, text: string): ApiError {
  const parsed = ErrorBody.safeParse(parseJson(text));
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(status, code, message, details);
  }
  return new ApiError(status, `http_${status}`, '');
}

let unauthorizedHandler: (() => void) | null = null;

/** What to do when a request finds the session gone. The app clears the cached `me`. */
export function setUnauthorizedHandler(h: (() => void) | null): void {
  unauthorizedHandler = h;
}

/**
 * Runs the unauthorized handler for a 401 `unauthorized`: the session ended
 * (signed out elsewhere, revoked, or the IdP re-check failed). A wrong
 * password is `invalid_credentials` and leaves the session alone.
 */
export function notifyUnauthorized(e: ApiError, redirectOn401 = true): void {
  if (redirectOn401 && e.status === 401 && e.code === 'unauthorized') unauthorizedHandler?.();
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/**
 * The English sentence to show for `e`: the server's own message when it sent
 * one, else `web.error.<code>` when that key exists, else a message chosen by
 * status. Raw response bodies are never shown.
 */
export function errorMessage(e: unknown, t: TFunction): string {
  if (!isApiError(e)) return t('web.error.generic');
  if (e.message) return e.message;
  const codeKey = `web.error.${e.code}`;
  if (i18n.exists(codeKey)) return t(codeKey);
  return t(statusKey(e.status));
}

function statusKey(status: number): string {
  if (status === 413) return 'web.error.tooLarge';
  if (status === 502 || status === 503 || status === 504) return 'web.error.unavailable';
  return 'web.error.generic';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function withCause(error: ApiError, cause: unknown): ApiError {
  error.cause = cause;
  return error;
}
