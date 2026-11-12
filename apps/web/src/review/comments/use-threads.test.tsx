import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client.ts';
import type { CommentThread } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { createQueryClient } from '../../api/query-client.ts';
import { fx } from '../../test/fixtures.ts';
import { API, server } from '../../test/server.ts';
import { guestBackend, guestPermissions, memberBackend, memberPermissions } from './backend.ts';
import {
  forgetGuestToken,
  GUEST_EDIT_WINDOW_MS,
  GUEST_TOKEN_HEADER,
  guestMayChange,
  guestTokenFor,
  rememberGuestToken,
  useGuestName,
} from './guest.ts';
import { useCommentActions, useThreads } from './use-threads.ts';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function harness() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const a = fx.thread({ id: 'cmt_a', created_at: 1 });
const ids = (list: CommentThread[] | undefined) => (list ?? []).map((t) => t.id);

test('mutations update the cache from their responses', async () => {
  let listRequests = 0;
  let created: unknown;
  const reply = fx.comment({ id: 'cmt_r1', thread_id: 'cmt_a', created_at: 5, body: 'a reply' });
  const fresh = fx.thread({ id: 'cmt_b', created_at: 2 });
  server.use(
    http.get(`${API}/artifacts/art_1/comments`, () => {
      listRequests += 1;
      return HttpResponse.json(fx.page([a]));
    }),
    http.post(`${API}/artifacts/art_1/comments`, async ({ request }) => {
      created = await request.json();
      return HttpResponse.json(fresh, { status: 201 });
    }),
    http.post(`${API}/comments/cmt_a/replies`, () => HttpResponse.json(reply, { status: 201 })),
    http.patch(`${API}/comments/cmt_r1`, () =>
      HttpResponse.json({ ...reply, body: 'fixed', edited_at: 9 }),
    ),
    http.post(`${API}/comments/cmt_a/resolve`, () =>
      HttpResponse.json({
        ...a,
        replies: [reply],
        status: 'resolved',
        resolved_in_version: { id: 'ver_1', number: 1 },
        resolved_at: 10,
      }),
    ),
    http.post(`${API}/comments/cmt_a/reopen`, () => HttpResponse.json({ ...a, replies: [reply] })),
    http.delete(`${API}/comments/cmt_r1`, () => new HttpResponse(null, { status: 204 })),
    http.delete(`${API}/comments/cmt_b`, () => new HttpResponse(null, { status: 204 })),
  );

  const backend = memberBackend('art_1');
  const { wrapper, queryClient } = harness();
  const { result } = renderHook(
    () => ({ threads: useThreads(backend), actions: useCommentActions(backend) }),
    { wrapper },
  );
  await vi.waitFor(() => expect(ids(result.current.threads.data)).toEqual(['cmt_a']));
  // The cache, read straight from the client: a hook re-renders a tick after it changes.
  const cached = () => queryClient.getQueryData<CommentThread[]>(qk.threads(backend.scope)) ?? [];

  // The thread is written on the version the anchor came from, named explicitly.
  await act(() =>
    result.current.actions.create.mutateAsync({
      body: 'new thread',
      anchor: fresh.anchor,
      versionId: 'ver_1',
    }),
  );
  expect(created).toEqual({ body: 'new thread', anchor: fresh.anchor, version_id: 'ver_1' });
  expect(ids(cached())).toEqual(['cmt_a', 'cmt_b']);

  await act(() => result.current.actions.reply.mutateAsync({ threadId: 'cmt_a', body: 'a reply' }));
  expect(cached()[0]?.replies).toEqual([reply]);

  await act(() => result.current.actions.edit.mutateAsync({ commentId: 'cmt_r1', body: 'fixed' }));
  expect(cached()[0]?.replies[0]).toMatchObject({ body: 'fixed', edited_at: 9 });

  await act(() =>
    result.current.actions.resolve.mutateAsync({ threadId: 'cmt_a', versionId: 'ver_1' }),
  );
  expect(cached()[0]?.status).toBe('resolved');

  await act(() => result.current.actions.reopen.mutateAsync('cmt_a'));
  expect(cached()[0]?.status).toBe('open');

  await act(() =>
    result.current.actions.remove.mutateAsync({ threadId: 'cmt_a', commentId: 'cmt_r1' }),
  );
  expect(cached()[0]?.replies).toEqual([]);

  await act(() =>
    result.current.actions.remove.mutateAsync({ threadId: 'cmt_b', commentId: 'cmt_b' }),
  );
  expect(ids(cached())).toEqual(['cmt_a']);

  // The component sees the same list, and every change came from a response: the list was read once.
  await vi.waitFor(() => expect(ids(result.current.threads.data)).toEqual(['cmt_a']));
  expect(listRequests).toBe(1);
});

test('a response for a list that was never read leaves the cache alone', async () => {
  server.use(
    http.post(`${API}/artifacts/art_1/comments`, () => HttpResponse.json(a, { status: 201 })),
  );
  const backend = memberBackend('art_1');
  const { wrapper, queryClient } = harness();
  const { result } = renderHook(() => useCommentActions(backend), { wrapper });
  await act(() =>
    result.current.create.mutateAsync({ body: 'hi', anchor: a.anchor, versionId: 'ver_1' }),
  );
  // Nothing was cached, so the first real read still happens.
  expect(queryClient.getQueryData(qk.threads(backend.scope))).toBeUndefined();
});

test('a failed post rejects with the server error and leaves the cache alone', async () => {
  server.use(
    http.get(`${API}/artifacts/art_1/comments`, () => HttpResponse.json(fx.page([a]))),
    http.post(`${API}/artifacts/art_1/comments`, () =>
      HttpResponse.json(
        { error: { code: 'gone', message: 'That version was deleted.' } },
        { status: 410 },
      ),
    ),
  );
  const backend = memberBackend('art_1');
  const { wrapper } = harness();
  const { result } = renderHook(
    () => ({ threads: useThreads(backend), actions: useCommentActions(backend) }),
    { wrapper },
  );
  await vi.waitFor(() => expect(ids(result.current.threads.data)).toEqual(['cmt_a']));
  await act(async () => {
    await expect(
      result.current.actions.create.mutateAsync({
        body: 'x',
        anchor: a.anchor,
        versionId: 'ver_9',
      }),
    ).rejects.toMatchObject({ code: 'gone', message: 'That version was deleted.' });
  });
  expect(ids(result.current.threads.data)).toEqual(['cmt_a']);
});

test('a member thread is never sent without the version it was written on', async () => {
  const posts: unknown[] = [];
  server.use(
    http.post(`${API}/artifacts/art_1/comments`, async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(a, { status: 201 });
    }),
  );
  const backend = memberBackend('art_1');
  // Without a version the server would write it on the current one.
  await expect(backend.create({ body: 'hi', anchor: a.anchor, versionId: null })).rejects.toThrow();
  expect(posts).toEqual([]);
});

test('member and guest backends name their scope and event stream', () => {
  const member = memberBackend('art_1');
  expect(member.scope).toEqual({ kind: 'artifact', artifactId: 'art_1' });
  expect(member.eventsPath).toBe('/api/v1/artifacts/art_1/events');
  expect(member.resolve).toBeTypeOf('function');
  expect(member.reopen).toBeTypeOf('function');

  const guest = guestBackend('tok', () => 'Lan');
  expect(guest.scope).toEqual({ kind: 'share', token: 'tok' });
  expect(guest.eventsPath).toBe('/api/v1/share/tok/events');
  expect(guest.resolve).toBeNull();
  expect(guest.reopen).toBeNull();
  expect(qk.threads(member.scope)).not.toEqual(qk.threads(guest.scope));
});

test('the guest backend signs with the name, keeps tokens, and maps the answers', async () => {
  const mine = fx.thread({ id: 'cmt_g', author: { type: 'guest', name: 'Lan' }, created_at: 1 });
  const guestReply = fx.comment({
    id: 'cmt_gr',
    thread_id: 'cmt_g',
    author: { type: 'guest', name: 'Lan' },
    created_at: 2,
  });
  const sent: unknown[] = [];
  const tokens: (string | null)[] = [];
  server.use(
    http.post(`${API}/share/tok/comments`, async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json(
        { thread: mine, comment_id: 'cmt_g', guest_token: 'gt-root' },
        { status: 201 },
      );
    }),
    http.post(`${API}/share/tok/comments/cmt_g/replies`, async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json(
        {
          thread: { ...mine, replies: [guestReply] },
          comment_id: 'cmt_gr',
          guest_token: 'gt-reply',
        },
        { status: 201 },
      );
    }),
    http.patch(`${API}/share/tok/comments/cmt_gr`, ({ request }) => {
      tokens.push(request.headers.get(GUEST_TOKEN_HEADER));
      return HttpResponse.json({ ...guestReply, body: 'edited' });
    }),
    http.delete(`${API}/share/tok/comments/cmt_gr`, ({ request }) => {
      tokens.push(request.headers.get(GUEST_TOKEN_HEADER));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  let name = 'Lan';
  const backend = guestBackend('tok', () => name);

  // The server uses the version the link shows: a guest sends no version.
  const created = await backend.create({ body: 'hi', anchor: mine.anchor, versionId: 'ver_1' });
  expect(created.id).toBe('cmt_g');
  expect(sent[0]).toEqual({ guest_name: 'Lan', body: 'hi', anchor: mine.anchor });
  expect(guestTokenFor('cmt_g')).toBe('gt-root');
  expect(sessionStorage.getItem('pinwall:guest-token:cmt_g')).toBe('gt-root');
  expect(localStorage.length).toBe(0);

  name = 'Lan Anh';
  const replied = await backend.reply('cmt_g', 'again');
  expect(replied).toEqual(guestReply);
  expect(sent[1]).toEqual({ guest_name: 'Lan Anh', body: 'again' });
  expect(guestTokenFor('cmt_gr')).toBe('gt-reply');

  expect((await backend.edit('cmt_gr', 'edited')).body).toBe('edited');
  await backend.remove('cmt_gr');
  expect(tokens).toEqual(['gt-reply', 'gt-reply']);
  // Deleting ends the token.
  expect(guestTokenFor('cmt_gr')).toBeNull();
  expect(guestTokenFor('cmt_g')).toBe('gt-root');
});

test('a guest reply the server does not return is an invalid response', async () => {
  server.use(
    http.post(`${API}/share/tok/comments/cmt_g/replies`, () =>
      HttpResponse.json(
        { thread: fx.thread({ id: 'cmt_g' }), comment_id: 'cmt_missing', guest_token: 'gt' },
        { status: 201 },
      ),
    ),
  );
  const rejection = guestBackend('tok', () => 'Lan').reply('cmt_g', 'hi');
  await expect(rejection).rejects.toBeInstanceOf(ApiError);
  await expect(rejection).rejects.toMatchObject({ code: 'invalid_response' });
  expect(guestTokenFor('cmt_missing')).toBeNull();
});

test('member permissions', () => {
  const author = fx.me({ id: 'usr_author', role: 'member' });
  const publisher = fx.me({ id: 'usr_publisher', role: 'member' });
  const admin = fx.me({ id: 'usr_admin', role: 'admin' });
  const other = fx.me({ id: 'usr_other', role: 'member' });
  const artifact = { created_by: 'usr_publisher' };
  const written = fx.comment({ author: { type: 'member', user_id: 'usr_author', name: 'Au' } });

  const can = (me: ReturnType<typeof fx.me>) => {
    const p = memberPermissions(me, artifact);
    return [p.canEdit(written), p.canDelete(written)];
  };
  expect(can(author)).toEqual([true, true]);
  expect(can(publisher)).toEqual([false, true]);
  expect(can(admin)).toEqual([false, true]);
  expect(can(other)).toEqual([false, false]);

  const p = memberPermissions(other, artifact);
  expect(p).toMatchObject({ canComment: true, canResolve: true, needsGuestName: false });

  // Guests, and members whose account is gone, are nobody's own comments.
  const guestWritten = fx.comment({ author: { type: 'guest', name: 'Lan' } });
  const gone = fx.comment({ author: { type: 'member', user_id: null, name: null } });
  expect(memberPermissions(author, artifact).canEdit(guestWritten)).toBe(false);
  expect(memberPermissions(author, artifact).canEdit(gone)).toBe(false);
  expect(memberPermissions(publisher, artifact).canDelete(guestWritten)).toBe(true);
  // An artifact without a publisher gives nobody publisher rights.
  expect(memberPermissions(other, { created_by: null }).canDelete(written)).toBe(false);
});

test('guest tokens live in sessionStorage and expire after 15 minutes', () => {
  expect(GUEST_TOKEN_HEADER).toBe('X-Pinwall-Guest-Token');
  expect(GUEST_EDIT_WINDOW_MS).toBe(900_000);

  const c = fx.comment({
    id: 'cmt_g',
    author: { type: 'guest', name: 'Lan' },
    created_at: 1_000_000,
  });
  // Without a token the guest may not change the comment.
  expect(guestMayChange(c, c.created_at)).toBe(false);

  rememberGuestToken('cmt_g', 'gt');
  expect(sessionStorage.getItem('pinwall:guest-token:cmt_g')).toBe('gt');
  expect(localStorage.getItem('pinwall:guest-token:cmt_g')).toBeNull();
  expect(guestTokenFor('cmt_g')).toBe('gt');
  expect(guestMayChange(c, c.created_at + 899_999)).toBe(true);
  expect(guestMayChange(c, c.created_at + 900_000)).toBe(false);

  // A member's comment is never the guest's, token or not.
  rememberGuestToken('cmt_m', 'gt');
  expect(guestMayChange(fx.comment({ id: 'cmt_m' }), 0)).toBe(false);

  const now = c.created_at + 1000;
  const permissions = guestPermissions(() => now);
  expect(permissions).toMatchObject({ canComment: true, canResolve: false, needsGuestName: true });
  expect(permissions.canEdit(c)).toBe(true);
  expect(permissions.canDelete(c)).toBe(true);
  expect(guestPermissions(() => c.created_at + GUEST_EDIT_WINDOW_MS).canEdit(c)).toBe(false);

  forgetGuestToken('cmt_g');
  expect(guestTokenFor('cmt_g')).toBeNull();
  expect(guestMayChange(c, c.created_at + 1)).toBe(false);
});

test('the guest name is remembered, trimmed and capped', () => {
  const first = renderHook(() => useGuestName());
  expect(first.result.current[0]).toBe('');
  act(() => first.result.current[1](' Lan '));
  expect(first.result.current[0]).toBe('Lan');
  expect(localStorage.getItem('pinwall:guest-name')).toBe('Lan');
  expect(sessionStorage.getItem('pinwall:guest-name')).toBeNull();

  // The next visit starts with the remembered name.
  expect(renderHook(() => useGuestName()).result.current[0]).toBe('Lan');

  act(() => first.result.current[1]('x'.repeat(61)));
  expect(first.result.current[0]).toBe('x'.repeat(60));
  expect(localStorage.getItem('pinwall:guest-name')).toBe('x'.repeat(60));

  // Clearing the name forgets it.
  act(() => first.result.current[1]('   '));
  expect(first.result.current[0]).toBe('');
  expect(localStorage.getItem('pinwall:guest-name')).toBeNull();
});

test('the guest name and tokens work without storage', () => {
  const blocked = () => {
    throw new DOMException('Blocked', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);

  const { result } = renderHook(() => useGuestName());
  expect(result.current[0]).toBe('');
  act(() => result.current[1]('Lan'));
  // The name stays for as long as the page is open.
  expect(result.current[0]).toBe('Lan');
  expect(() => rememberGuestToken('cmt_g', 'gt')).not.toThrow();
  expect(guestTokenFor('cmt_g')).toBeNull();
  expect(() => forgetGuestToken('cmt_g')).not.toThrow();
});
