import type { Page } from '@playwright/test';

/*
 * Pinwall's API, called from inside a page at the app origin. Node cannot resolve the
 * `*.localhost` names the content-domain server lives at, and a request from the page carries
 * the session cookie and the `Origin` the CSRF check wants, as the app's own requests do.
 */

/** The owner account every review run creates. */
export const OWNER = { name: 'Ada', password: 'correct horse battery staple' } as const;

/** What the suite reads of a publish's answer (`PublishResult` in `@pinwall/shared`). */
export interface PublishResult {
  artifact_id: string;
  version_id: string;
  version_number: number;
  entry_path: string;
  review_url: string;
  raw_url: string;
}

/** A publish target: `{}` is a new artifact; `{ artifact_id, expected_version_id }` a new version. */
export type PublishTarget =
  | { artifact_id: string; expected_version_id: string }
  | { project_id?: string | null; name?: string; tags?: string[] };

interface ApiError {
  error?: { code?: string; message?: string };
}

/**
 * `method path` with `body` as JSON, from inside `page`, which must show a page of the app
 * origin. The answer's body is parsed as JSON, or null when there is none.
 */
export function apiCall<T = unknown>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: text === '' ? null : JSON.parse(text) };
    },
    { method, path, body },
  );
}

/**
 * Opens the app at `s.origin` in `page` and signs in as the owner: creates the owner account
 * through the setup link the first time, and signs in with its password once setup is done.
 */
export async function bootstrap(
  page: Page,
  s: { origin: string; setupUrl: string },
): Promise<void> {
  await page.goto(new URL('/signin', s.origin).href);
  const token = new URL(s.setupUrl).searchParams.get('token');
  const setup = await apiCall<ApiError | null>(page, 'POST', '/api/v1/auth/setup', {
    token,
    name: OWNER.name,
    password: OWNER.password,
  });
  if (setup.status === 201) return;
  if (setup.status !== 409 || setup.json?.error?.code !== 'setup_done') {
    throw new Error(`Setup answered ${setup.status}: ${JSON.stringify(setup.json)}`);
  }
  const signIn = await apiCall<ApiError | null>(page, 'POST', '/api/v1/auth/password/sign-in', {
    password: OWNER.password,
  });
  if (signIn.status !== 200) {
    throw new Error(`Sign-in answered ${signIn.status}: ${JSON.stringify(signIn.json)}`);
  }
}

/** The answer of a publish, or an error naming the status and the server's message. */
function published(answer: { status: number; json: unknown }): PublishResult {
  if (answer.status !== 201) {
    throw new Error(`Publishing answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  }
  return answer.json as PublishResult;
}

/** Publishes text files given by path (`POST /api/v1/publish/inline`). */
export async function publishInline(
  page: Page,
  files: Record<string, string>,
  target: PublishTarget = {},
): Promise<PublishResult> {
  const body = {
    target,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  };
  return published(await apiCall(page, 'POST', '/api/v1/publish/inline', body));
}

/**
 * Publishes files by path as a browser folder upload does (`POST /api/v1/publish/upload`): the
 * multipart form is built inside the page, a `path` field before each file.
 */
export async function publishUpload(
  page: Page,
  files: Record<string, string | Buffer>,
  target: PublishTarget = {},
): Promise<PublishResult> {
  const parts = Object.entries(files).map(([path, content]) => ({
    path,
    base64: (typeof content === 'string' ? Buffer.from(content) : content).toString('base64'),
  }));
  const answer = await page.evaluate(
    async ({ target, parts }) => {
      const form = new FormData();
      form.append('target', JSON.stringify(target));
      for (const { path, base64 } of parts) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        form.append('path', path);
        form.append('file', new Blob([bytes]), path.slice(path.lastIndexOf('/') + 1));
      }
      const response = await fetch('/api/v1/publish/upload', {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        body: form,
      });
      const text = await response.text();
      return { status: response.status, json: text === '' ? null : JSON.parse(text) };
    },
    { target, parts },
  );
  return published(answer);
}
