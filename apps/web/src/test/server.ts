import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * The mock network for every test. `test-setup.ts` starts it, drops the
 * handlers a test added once it ends, and fails any request no handler takes.
 */
export const server = setupServer();

/** Prefix for handler paths: `http.get(\`${API}/me\`, …)` matches the API on any origin. */
export const API = '*/api/v1';

/** A Pinwall error response: `{ error: { code, message, details? } }`. */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return HttpResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}
