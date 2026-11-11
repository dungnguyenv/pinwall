import { delay, HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, errorMessage, setUnauthorizedHandler } from '../../api/client.ts';
import type { PublishResult } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { formParts } from '../../test/multipart.ts';
import { API, apiError, server } from '../../test/server.ts';
import { buildUploadForm, sendUpload, type UploadProgress } from './send.ts';

const t = i18n.t.bind(i18n);

const published: PublishResult = {
  artifact_id: 'art_9',
  version_id: 'ver_9',
  version_number: 1,
  kind: 'html',
  entry_path: 'index.html',
  file_count: 2,
  total_bytes: 30,
  review_url: 'http://localhost:3000/a/art_9',
  raw_url: 'http://localhost:3000/a/art_9/v/1/raw',
  warnings: [],
};

function form(): FormData {
  return buildUploadForm(
    { project_id: 'prj_1' },
    {
      kind: 'files',
      files: [
        { path: 'site/index.html', file: new File(['<h1>Hi</h1>'], 'index.html') },
        { path: 'site/a.css', file: new File(['h1{}'], 'a.css') },
      ],
    },
  );
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

afterEach(() => setUnauthorizedHandler(null));

test('uploads and returns the published version', async () => {
  let parts: [string, string][] = [];
  let accept: string | null = null;
  server.use(
    http.post(`${API}/publish/upload`, async ({ request }) => {
      accept = request.headers.get('accept');
      parts = await formParts(request);
      return HttpResponse.json(published, { status: 201 });
    }),
  );
  const progress: UploadProgress[] = [];
  const result = await sendUpload(form(), { onProgress: (p) => progress.push(p) });

  expect(result).toEqual(published);
  expect(accept).toBe('application/json');
  expect(parts).toEqual([
    ['target', '{"project_id":"prj_1"}'],
    ['path', 'site/index.html'],
    ['file', 'index.html'],
    ['path', 'site/a.css'],
    ['file', 'a.css'],
  ]);
  expect(progress.some((p) => p.phase === 'uploading')).toBe(true);
  const last = progress.at(-1);
  expect(last?.phase).toBe('processing');
  expect(last?.loaded).toBe(last?.total);
  expect(last?.total).toBeGreaterThan(0);
});

test('server errors come back verbatim', async () => {
  const message = '../x: path segments "." and ".." are not allowed.';
  server.use(
    http.post(`${API}/publish/upload`, () =>
      apiError(400, 'bad_request', message, { reason: 'dot_segment', path: '../x' }),
    ),
  );
  const error = await failure(sendUpload(form(), {}));
  expect(error.status).toBe(400);
  expect(error.code).toBe('bad_request');
  expect(error.message).toBe(message);
  expect(error.details?.reason).toBe('dot_segment');
  expect(errorMessage(error, t)).toBe(message);
});

test('a proxy 413 page gets a clear message', async () => {
  server.use(
    http.post(
      `${API}/publish/upload`,
      () =>
        new HttpResponse('<html><body><h1>413 Request Entity Too Large</h1></body></html>', {
          status: 413,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  );
  const error = await failure(sendUpload(form(), {}));
  expect(error.code).toBe('http_413');
  expect(errorMessage(error, t)).toBe(t('web.error.tooLarge'));
});

test('a success the client does not understand is an invalid response', async () => {
  server.use(
    http.post(`${API}/publish/upload`, () => HttpResponse.json({ ok: true }, { status: 201 })),
  );
  const error = await failure(sendUpload(form(), {}));
  expect(error.code).toBe('invalid_response');
});

test('a dropped connection is a network error', async () => {
  server.use(http.post(`${API}/publish/upload`, () => HttpResponse.error()));
  const error = await failure(sendUpload(form(), {}));
  expect(error.code).toBe('network');
  expect(errorMessage(error, t)).toBe(t('web.error.network'));
});

test('cancel aborts the request', async () => {
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  server.use(
    http.post(`${API}/publish/upload`, async () => {
      reached();
      await delay(10_000);
      return HttpResponse.json(published, { status: 201 });
    }),
  );
  const controller = new AbortController();
  const sending = sendUpload(form(), { signal: controller.signal });
  await arrived;
  controller.abort();
  const error = await failure(sending);
  expect(error.status).toBe(0);
  expect(error.code).toBe('aborted');

  // Already cancelled: nothing is sent.
  const early = await failure(sendUpload(form(), { signal: controller.signal }));
  expect(early.code).toBe('aborted');
});

test('a 401 sends the user to sign in', async () => {
  const unauthorized = vi.fn();
  setUnauthorizedHandler(unauthorized);
  server.use(
    http.post(`${API}/publish/upload`, () => apiError(401, 'unauthorized', 'Sign in to continue.')),
  );
  const error = await failure(sendUpload(form(), {}));
  expect(error.code).toBe('unauthorized');
  expect(unauthorized).toHaveBeenCalledOnce();
});
