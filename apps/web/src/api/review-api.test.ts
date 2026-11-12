import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { createElement, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { fx } from '../test/fixtures.ts';
import { API, apiError, server } from '../test/server.ts';
import { setUnauthorizedHandler } from './client.ts';
import {
  createThread,
  deleteComment,
  editComment,
  listAllThreads,
  reopenThread,
  replyTo,
  resolveThread,
} from './comments.ts';
import { useMarkdownDiff, useTextFileDiff, useVersionDiff } from './diff.ts';
import { createQueryClient } from './query-client.ts';
import {
  createShareLink,
  getShareInfo,
  guestCreateThread,
  guestDelete,
  guestEdit,
  guestReply,
  listGuestThreads,
  listShareLinks,
  revokeShareLink,
  unlockShare,
} from './shares.ts';
import {
  deleteArtifact,
  deleteVersion,
  getPreview,
  rawPath,
  restoreVersion,
  reviewPath,
  useReviewGrant,
  useVersions,
} from './versions.ts';

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.useRealTimers();
});

function wrapper() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

test('all threads are read page by page', async () => {
  const requests: Record<string, string>[] = [];
  server.use(
    http.get(`${API}/artifacts/art_1/comments`, ({ request }) => {
      const params = query(request);
      requests.push(params);
      return params.cursor === 'c2'
        ? HttpResponse.json(fx.page([fx.thread({ id: 'cmt_c', created_at: 3 })]))
        : HttpResponse.json(
            fx.page(
              [
                fx.thread({ id: 'cmt_a', created_at: 1 }),
                fx.thread({ id: 'cmt_b', created_at: 2 }),
              ],
              'c2',
            ),
          );
    }),
  );

  const threads = await listAllThreads('art_1');
  expect(threads.map((t) => t.id)).toEqual(['cmt_a', 'cmt_b', 'cmt_c']);
  expect(requests).toEqual([
    { status: 'all', limit: '200' },
    { status: 'all', limit: '200', cursor: 'c2' },
  ]);
});

/** Pages of 200 threads that never end. */
function endlessPages(onRequest: () => void) {
  let pageNumber = 0;
  return () => {
    onRequest();
    pageNumber += 1;
    const items = Array.from({ length: 200 }, (_, i) =>
      fx.thread({ id: `cmt_${pageNumber}_${i}`, created_at: pageNumber * 1000 + i }),
    );
    return HttpResponse.json(fx.page(items, `c${pageNumber + 1}`));
  };
}

test('thread reading stops at 1000', async () => {
  let requests = 0;
  server.use(
    http.get(
      `${API}/artifacts/art_1/comments`,
      endlessPages(() => {
        requests += 1;
      }),
    ),
  );
  expect(await listAllThreads('art_1')).toHaveLength(1000);
  expect(requests).toBe(5);
});

test('paging ends when the server repeats a cursor', async () => {
  let requests = 0;
  server.use(
    http.get(`${API}/artifacts/art_1/comments`, () => {
      requests += 1;
      return HttpResponse.json(fx.page([fx.thread({ id: `cmt_${requests}` })], 'same'));
    }),
  );
  expect(await listAllThreads('art_1')).toHaveLength(2);
  expect(requests).toBe(2);
});

test('guest threads are read the same way through the share token', async () => {
  const requests: Record<string, string>[] = [];
  server.use(
    http.get(`${API}/share/tok/comments`, ({ request }) => {
      requests.push(query(request));
      return HttpResponse.json(fx.page([fx.thread({ id: 'cmt_a' })]));
    }),
  );
  expect((await listGuestThreads('tok')).map((t) => t.id)).toEqual(['cmt_a']);
  expect(requests).toEqual([{ status: 'all', limit: '200' }]);
});

test('member comment calls use the comment routes', async () => {
  const seen: string[] = [];
  const record = async (request: Request) => {
    const body = request.headers.get('content-type') ? await request.json() : undefined;
    seen.push(`${request.method} ${new URL(request.url).pathname} ${JSON.stringify(body ?? null)}`);
  };
  const thread = fx.thread({ id: 'cmt_a' });
  const comment = fx.comment({ id: 'cmt_r1', thread_id: 'cmt_a' });
  server.use(
    http.post(`${API}/artifacts/art_1/comments`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(thread, { status: 201 });
    }),
    http.post(`${API}/comments/cmt_a/replies`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(comment, { status: 201 });
    }),
    http.patch(`${API}/comments/cmt_r1`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(comment);
    }),
    http.delete(`${API}/comments/cmt_r1`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/comments/cmt_a/resolve`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(thread);
    }),
    http.post(`${API}/comments/cmt_a/reopen`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(thread);
    }),
  );

  await createThread('art_1', { body: 'hi', anchor: thread.anchor, version_id: 'ver_1' });
  await replyTo('cmt_a', 'again');
  await editComment('cmt_r1', 'fixed');
  await deleteComment('cmt_r1');
  await resolveThread('cmt_a', 'ver_2');
  await reopenThread('cmt_a');

  expect(seen).toEqual([
    `POST /api/v1/artifacts/art_1/comments ${JSON.stringify({ body: 'hi', anchor: thread.anchor, version_id: 'ver_1' })}`,
    'POST /api/v1/comments/cmt_a/replies {"body":"again"}',
    'PATCH /api/v1/comments/cmt_r1 {"body":"fixed"}',
    'DELETE /api/v1/comments/cmt_r1 null',
    'POST /api/v1/comments/cmt_a/resolve {"version_id":"ver_2"}',
    'POST /api/v1/comments/cmt_a/reopen null',
  ]);
});

test('guest edits send the guest token header', async () => {
  const seen: { path: string; token: string | null; body: unknown }[] = [];
  server.use(
    http.patch(`${API}/share/tok/comments/cmt_1`, async ({ request }) => {
      seen.push({
        path: new URL(request.url).pathname,
        token: request.headers.get('x-pinwall-guest-token'),
        body: await request.json(),
      });
      return HttpResponse.json(fx.comment({ id: 'cmt_1', body: 'new text' }));
    }),
    http.delete(`${API}/share/tok/comments/cmt_1`, ({ request }) => {
      seen.push({
        path: new URL(request.url).pathname,
        token: request.headers.get('x-pinwall-guest-token'),
        body: null,
      });
      return new HttpResponse(null, { status: 204 });
    }),
  );

  expect((await guestEdit('tok', 'cmt_1', 'new text', 'gt')).body).toBe('new text');
  await guestDelete('tok', 'cmt_1', 'gt');
  expect(seen).toEqual([
    { path: '/api/v1/share/tok/comments/cmt_1', token: 'gt', body: { body: 'new text' } },
    { path: '/api/v1/share/tok/comments/cmt_1', token: 'gt', body: null },
  ]);
});

test('guest writes send the guest name and return what the server made', async () => {
  const thread = fx.thread({ id: 'cmt_g', author: { type: 'guest', name: 'Lan' } });
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API}/share/tok/comments`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        { thread, comment_id: 'cmt_g', guest_token: 'gt1' },
        { status: 201 },
      );
    }),
    http.post(`${API}/share/tok/comments/cmt_g/replies`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(
        { thread, comment_id: 'cmt_r', guest_token: 'gt2' },
        { status: 201 },
      );
    }),
  );

  expect(
    await guestCreateThread('tok', { guest_name: 'Lan', body: 'hi', anchor: thread.anchor }),
  ).toEqual({ thread, comment_id: 'cmt_g', guest_token: 'gt1' });
  expect((await guestReply('tok', 'cmt_g', { guest_name: 'Lan', body: 'again' })).guest_token).toBe(
    'gt2',
  );
  expect(bodies).toEqual([
    { guest_name: 'Lan', body: 'hi', anchor: thread.anchor },
    { guest_name: 'Lan', body: 'again' },
  ]);
});

test('share calls never redirect to sign in', async () => {
  const unauthorized = vi.fn();
  setUnauthorizedHandler(unauthorized);
  server.use(
    http.all(`${API}/share/*`, () =>
      apiError(401, 'unauthorized', 'This link needs its password.', { password_required: true }),
    ),
  );
  const anchor = fx.thread().anchor;

  await expect(getShareInfo('tok')).rejects.toMatchObject({
    status: 401,
    code: 'unauthorized',
    details: { password_required: true },
  });
  const calls = [
    unlockShare('tok', 'secret-password'),
    listGuestThreads('tok'),
    guestCreateThread('tok', { guest_name: 'Lan', body: 'hi', anchor }),
    guestReply('tok', 'cmt_1', { guest_name: 'Lan', body: 'hi' }),
    guestEdit('tok', 'cmt_1', 'hi', 'gt'),
    guestDelete('tok', 'cmt_1', 'gt'),
  ];
  for (const call of calls) await expect(call).rejects.toMatchObject({ status: 401 });
  expect(unauthorized).not.toHaveBeenCalled();

  // A member's own share-link management is not a share viewer call: it does sign out.
  server.use(
    http.get(`${API}/artifacts/art_1/share-links`, () =>
      apiError(401, 'unauthorized', 'Sign in to continue.'),
    ),
  );
  await expect(listShareLinks('art_1')).rejects.toMatchObject({ status: 401 });
  expect(unauthorized).toHaveBeenCalledOnce();
});

test('share link calls use the member routes and the share viewer routes', async () => {
  const seen: string[] = [];
  const link = fx.shareLink({ id: 'shl_1' });
  server.use(
    http.get(`${API}/artifacts/art_1/share-links`, ({ request }) => {
      seen.push(`GET share-links ${JSON.stringify(query(request))}`);
      return HttpResponse.json(fx.page([link], 'next'));
    }),
    http.post(`${API}/artifacts/art_1/share-links`, async ({ request }) => {
      seen.push(`POST share-links ${JSON.stringify(await request.json())}`);
      return HttpResponse.json(
        { link, token: 'tok', url: 'http://localhost:3000/s/tok' },
        { status: 201 },
      );
    }),
    http.delete(`${API}/share-links/shl_1`, () => {
      seen.push('DELETE share-links/shl_1');
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/share/tok`, () => {
      seen.push('GET share/tok');
      return HttpResponse.json(fx.shareInfo({ artifact_name: 'Homepage' }));
    }),
    http.post(`${API}/share/tok/unlock`, async ({ request }) => {
      seen.push(`POST unlock ${JSON.stringify(await request.json())}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  expect((await listShareLinks('art_1', 'c1')).next_cursor).toBe('next');
  expect((await createShareLink('art_1', { allow_comments: true, version_id: null })).token).toBe(
    'tok',
  );
  await revokeShareLink('shl_1');
  const info = await getShareInfo('tok');
  expect(info.artifact_name).toBe('Homepage');
  expect(info.original_url).toBe('http://localhost:3000/s/tok/original');
  await unlockShare('tok', 'secret-password');

  expect(seen).toEqual([
    'GET share-links {"limit":"50","cursor":"c1"}',
    'POST share-links {"allow_comments":true,"version_id":null}',
    'DELETE share-links/shl_1',
    'GET share/tok',
    'POST unlock {"password":"secret-password"}',
  ]);
});

test('version calls use the version routes', async () => {
  const seen: string[] = [];
  server.use(
    http.get(`${API}/artifacts/art_1/versions`, ({ request }) => {
      seen.push(`GET versions ${JSON.stringify(query(request))}`);
      return HttpResponse.json(fx.page([fx.version({ number: 2 })], 'older'));
    }),
    http.get(`${API}/artifacts/art_1/versions/2/preview`, ({ request }) => {
      seen.push(`GET preview ${JSON.stringify(query(request))}`);
      return HttpResponse.json(
        fx.grant({ mode: query(request).mode === 'raw' ? 'raw' : 'review' }),
      );
    }),
    http.post(`${API}/artifacts/art_1/versions/1/restore`, async ({ request }) => {
      seen.push(`POST restore ${JSON.stringify(await request.json())}`);
      return HttpResponse.json(fx.version({ number: 3 }), { status: 201 });
    }),
    http.delete(`${API}/artifacts/art_1/versions/1`, () => {
      seen.push('DELETE version');
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${API}/artifacts/art_1`, () => {
      seen.push('DELETE artifact');
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const { result } = renderHook(() => useVersions('art_1'), { wrapper: wrapper() });
  await vi.waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.number).toBe(2));
  expect(result.current.hasNextPage).toBe(true);

  expect((await getPreview('art_1', 2, 'raw')).mode).toBe('raw');
  expect((await getPreview('art_1', 2, 'review')).mode).toBe('review');
  expect((await restoreVersion('art_1', 1, 'ver_2')).number).toBe(3);
  await deleteVersion('art_1', 1);
  await deleteArtifact('art_1');

  expect(seen).toEqual([
    'GET versions {"limit":"50"}',
    'GET preview {"mode":"raw"}',
    'GET preview {"mode":"review"}',
    'POST restore {"expected_version_id":"ver_2"}',
    'DELETE version',
    'DELETE artifact',
  ]);
});

test('the next page of versions follows the cursor', async () => {
  const cursors: (string | undefined)[] = [];
  server.use(
    http.get(`${API}/artifacts/art_1/versions`, ({ request }) => {
      const cursor = query(request).cursor;
      cursors.push(cursor);
      return HttpResponse.json(
        cursor
          ? fx.page([fx.version({ number: 1 })])
          : fx.page([fx.version({ number: 2 })], 'older'),
      );
    }),
  );
  const { result } = renderHook(() => useVersions('art_1'), { wrapper: wrapper() });
  await vi.waitFor(() => expect(result.current.hasNextPage).toBe(true));
  await result.current.fetchNextPage();
  await vi.waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
  expect(result.current.hasNextPage).toBe(false);
  expect(cursors).toEqual([undefined, 'older']);
});

/** Counts previews and answers each with a review grant that expires `ttl` ms from now. */
function servePreviews(ttl: number) {
  const state = { count: 0 };
  server.use(
    http.get(`${API}/artifacts/art_1/versions/2/preview`, () => {
      state.count += 1;
      return HttpResponse.json(fx.grant({ expires_at: Date.now() + ttl }));
    }),
  );
  return state;
}

// Only the clock and the interval timer are faked, so the mock network keeps
// answering on real timers. The clock stands still while a test waits for it
// (vi.waitFor would move it), which makes the renewal delay exact.
const fakeClock = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

test('the review grant renews five minutes before it expires', async () => {
  fakeClock();
  const previews = servePreviews(600_000);
  const { result } = renderHook(() => useReviewGrant('art_1', 2), { wrapper: wrapper() });
  await until(() => result.current.data?.mode === 'review');
  expect(previews.count).toBe(1);

  await vi.advanceTimersByTimeAsync(299_999);
  expect(previews.count).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => previews.count === 2);

  // The renewed grant expires 600 s after the renewal: the next one is 300 s on.
  await until(() => result.current.dataUpdatedAt >= Date.now());
  await vi.advanceTimersByTimeAsync(299_999);
  expect(previews.count).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => previews.count === 3);
});

test('an almost expired grant is renewed every minute', async () => {
  fakeClock();
  const previews = servePreviews(100_000);
  const { result } = renderHook(() => useReviewGrant('art_1', 2), { wrapper: wrapper() });
  await until(() => result.current.data?.mode === 'review');

  await vi.advanceTimersByTimeAsync(59_999);
  expect(previews.count).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => previews.count === 2);
});

test('the review grant waits for a version number', async () => {
  const { result } = renderHook(() => useReviewGrant('art_1', null), { wrapper: wrapper() });
  expect(result.current.fetchStatus).toBe('idle');
});

test('diff queries stay idle while an argument is null, then read the diff routes', async () => {
  const seen: string[] = [];
  const file = { sha256: 'a'.repeat(64), size: 3, content_type: 'text/html' };
  server.use(
    http.get(`${API}/artifacts/art_1/diff`, ({ request }) => {
      seen.push(`diff ${JSON.stringify(query(request))}`);
      return HttpResponse.json({
        from: 1,
        to: 2,
        files: [{ path: 'index.html', status: 'modified', old: file, new: file }],
      });
    }),
    http.get(`${API}/artifacts/art_1/diff/file`, ({ request }) => {
      seen.push(`file ${JSON.stringify(query(request))}`);
      return HttpResponse.json({
        path: 'index.html',
        binary: false,
        too_large: false,
        patch: '@@ -1 +1 @@\n-a\n+b\n',
        old: file,
        new: file,
      });
    }),
    http.get(`${API}/artifacts/art_1/diff/markdown`, ({ request }) => {
      seen.push(`markdown ${JSON.stringify(query(request))}`);
      return HttpResponse.json({ path: 'README.md', too_large: false, blocks: [] });
    }),
  );

  const idle = renderHook(
    () => [
      useVersionDiff('art_1', null, 2),
      useVersionDiff('art_1', 1, null),
      useTextFileDiff('art_1', 1, 2, null),
      useMarkdownDiff('art_1', null, 2, 'README.md'),
    ],
    { wrapper: wrapper() },
  );
  expect(idle.result.current.map((q) => q.fetchStatus)).toEqual(['idle', 'idle', 'idle', 'idle']);

  const { result } = renderHook(
    () => ({
      files: useVersionDiff('art_1', 1, 2),
      text: useTextFileDiff('art_1', 1, 2, 'index.html'),
      markdown: useMarkdownDiff('art_1', 1, 2, 'README.md'),
    }),
    { wrapper: wrapper() },
  );
  await vi.waitFor(() => {
    expect(result.current.files.data?.files[0]?.path).toBe('index.html');
    expect(result.current.text.data?.patch).toContain('+b');
    expect(result.current.markdown.data?.path).toBe('README.md');
  });
  expect([...seen].sort()).toEqual([
    'diff {"from":"1","to":"2"}',
    'file {"from":"1","to":"2","path":"index.html"}',
    'markdown {"from":"1","to":"2","path":"README.md"}',
  ]);
});

test('paths', () => {
  expect(reviewPath('art_1')).toBe('/a/art_1');
  expect(reviewPath('art_1', null)).toBe('/a/art_1');
  expect(reviewPath('art_1', 2)).toBe('/a/art_1/v/2');
  expect(rawPath('art_1')).toBe('/a/art_1/raw');
  expect(rawPath('art_1', 2)).toBe('/a/art_1/v/2/raw');
});
