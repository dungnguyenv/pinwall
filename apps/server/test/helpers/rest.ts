import { apiInit } from './auth.ts';
import type { TestContext } from './context.ts';

export interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface Reply<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/**
 * JSON calls to `/api/v1` as the holder of `cookie`: `get`, `post` and `patch` return the status,
 * the headers and the parsed body (`null` when there is none).
 */
export function restClient(ctx: TestContext, cookie: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const res = await ctx.request(`/api/v1${path}`, apiInit(ctx, { method, body, cookie }));
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: (text === '' ? null : JSON.parse(text)) as T,
    };
  }
  return {
    get: <T = unknown>(path: string) => call<T>('GET', path),
    post: <T = unknown>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
    patch: <T = unknown>(path: string, body: unknown) => call<T>('PATCH', path, body),
  };
}
