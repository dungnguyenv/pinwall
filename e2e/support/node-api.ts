import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

/*
 * Pinwall's REST API from Node, against an install on `http://localhost:<port>`, the way a
 * script or an agent's shell calls it: a session cookie or a bearer token, and the `Origin`
 * header that the CSRF check wants on writes. Only the `*.localhost` hosts of content-domain
 * mode need a browser, which resolves them; Node is enough for everything else.
 */

const execFileAsync = promisify(execFile);

/** The owner every acceptance install creates. */
export const OWNER_NAME = 'Ada';

export interface ApiResponse<T> {
  status: number;
  /** The parsed JSON body; null when the body is empty or not JSON. */
  json: T;
  headers: Headers;
}

export interface Api {
  origin: string;
  /** `pinwall_session=<value>`, or '' for a client that signs requests with a bearer token. */
  cookie: string;
  /**
   * `method path` with `body` as JSON. Redirects are not followed, so a raw link's grant can be
   * read from its `location`. `headers` are added last and win.
   */
  call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResponse<T>>;
}

/** What a publish answers (`PublishResult` in `@pinwall/shared`), as far as the suite reads it. */
export interface Published {
  artifact_id: string;
  version_id: string;
  version_number: number;
  review_url: string;
  raw_url: string;
}

async function parsed<T>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  let json: unknown = null;
  if (text !== '' && /json/.test(response.headers.get('content-type') ?? '')) {
    json = JSON.parse(text);
  }
  return { status: response.status, json: json as T, headers: response.headers };
}

/** A client for `origin` that sends `cookie`, or `authorization: Bearer <bearer>`. */
export function apiClient(origin: string, auth: { cookie?: string; bearer?: string }): Api {
  const cookie = auth.cookie ?? '';
  return {
    origin,
    cookie,
    async call<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
      const upper = method.toUpperCase();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (cookie !== '') headers.cookie = cookie;
      if (auth.bearer !== undefined) headers.authorization = `Bearer ${auth.bearer}`;
      if (upper !== 'GET' && upper !== 'HEAD') headers.origin = origin;
      if (body !== undefined) headers['content-type'] = 'application/json';
      Object.assign(headers, extra);
      const response = await fetch(new URL(path, origin), {
        method: upper,
        headers,
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return parsed<T>(response);
    },
  };
}

/** The `name=value` of the session cookie `response` sets; throws when there is none. */
function sessionCookie(response: ApiResponse<unknown>, what: string): string {
  for (const header of response.headers.getSetCookie()) {
    const match = /^((?:__Host-)?pinwall_session)=([^;]+)/.exec(header);
    if (match) return `${match[1]}=${match[2]}`;
  }
  throw new Error(`${what} answered ${response.status} without a session cookie`);
}

/** Creates the owner (`Ada`, with `password`) through the one-time setup link, signed in. */
export async function setupAndSignIn(
  origin: string,
  setupUrl: string,
  password: string,
): Promise<Api> {
  const token = new URL(setupUrl).searchParams.get('token');
  const answer = await apiClient(origin, {}).call('POST', '/api/v1/auth/setup', {
    token,
    name: OWNER_NAME,
    password,
  });
  if (answer.status !== 201) {
    throw new Error(`Setup answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  }
  return apiClient(origin, { cookie: sessionCookie(answer, 'Setup') });
}

/** Signs the owner in with the password. */
export async function signIn(origin: string, password: string): Promise<Api> {
  const answer = await apiClient(origin, {}).call('POST', '/api/v1/auth/password/sign-in', {
    password,
  });
  if (answer.status !== 200) {
    throw new Error(`Sign-in answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  }
  return apiClient(origin, { cookie: sessionCookie(answer, 'Sign-in') });
}

/**
 * Publishes `files` (paths in the site) as an agent with a shell does: asks for an upload URL,
 * packs the folder with the system `tar -czf`, and posts the archive to the URL with no other
 * credential. `target` is a publish target (`{}`, a new artifact, by default).
 */
export async function publishSite(
  api: Api,
  files: Record<string, string | Buffer>,
  target: object = {},
): Promise<Published> {
  const session = await api.call<{ upload_url: string }>('POST', '/api/v1/publish-sessions', {
    target,
  });
  if (session.status !== 201) {
    throw new Error(`Upload URL answered ${session.status}: ${JSON.stringify(session.json)}`);
  }
  const work = await mkdtemp(join(tmpdir(), 'pinwall-acc-site-'));
  try {
    const site = join(work, 'site');
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(site, path)), { recursive: true });
      await writeFile(join(site, path), content);
    }
    const archive = join(work, 'site.tar.gz');
    // COPYFILE_DISABLE keeps macOS tar from adding `._*` files for extended attributes.
    await execFileAsync('tar', ['-czf', archive, '-C', site, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    // As `curl --data-binary @-` sends it.
    const response = await fetch(session.json.upload_url, {
      method: 'POST',
      body: await readFile(archive),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const answer = await parsed<Published>(response);
    if (answer.status !== 201) {
      throw new Error(`The upload answered ${answer.status}: ${JSON.stringify(answer.json)}`);
    }
    return answer.json;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
