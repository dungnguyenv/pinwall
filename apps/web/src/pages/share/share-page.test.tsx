import type { Anchor } from '@pinwall/shared/protocol';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import type { Comment, CommentThread, LiveEvent, ShareInfo } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { browser } from '../../lib/navigation.ts';
import { CONTENT_SANDBOX } from '../../review/frame/sandbox.ts';
import { simFrame } from '../../test/annotator-sim.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { pointAt, quoteOf } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const TIMEOUT = { timeout: 5000 };

/** The content URL of the grant the link hands out for version `n`. */
const grantUrl = (n: number) => `https://content.example/g/share-v${n}/`;
const ORIGINAL = 'http://localhost:3000/s/tok/original';

/** "Pricing" v`n`, shared through a link that follows the latest version and allows comments. */
function pricing(n: number, o: Partial<ShareInfo> = {}): ShareInfo {
  const comments = o.allow_comments ?? true;
  return fx.shareInfo({
    artifact_name: 'Pricing',
    version_number: n,
    follows_current: true,
    allow_comments: comments,
    original_url: ORIGINAL,
    content: fx.grant({ url: grantUrl(n), mode: comments ? 'review' : 'raw' }),
    ...o,
  });
}

/** A thread as the share API returns it: on v`n`, members by name only. */
function sharedThread(o: Partial<CommentThread> & { n?: number } = {}): CommentThread {
  const { n = 3, ...rest } = o;
  return fx.thread({
    version: { id: `ver_${n}`, number: n },
    author: { type: 'member', user_id: null, name: 'Ada' },
    anchor: pointAt(0.3, 0.2),
    ...rest,
  });
}

const guest = (name: string) => ({ type: 'guest' as const, name });

interface ShareServer {
  /** What `GET /share/tok` answers now. */
  info: ShareInfo;
  threads: CommentThread[];
  /** Every request, as `METHOD /path`, in order. */
  requests: string[];
  /** The JSON bodies of guest thread creations. */
  created: unknown[];
  /** Guest edits: the comment, the body sent and the guest token header. */
  edits: { id: string; body: unknown; guestToken: string | null }[];
  gets(path: string): number;
}

/**
 * Serves share link `tok`: its info, its threads, guest thread creation (each
 * new thread `cmt_newN` with guest token `gt_N`) and guest edits. Records
 * every request.
 */
function serveShare(o: { info: ShareInfo; threads?: CommentThread[] }): ShareServer {
  const state: ShareServer = {
    info: o.info,
    threads: o.threads ?? [],
    requests: [],
    created: [],
    edits: [],
    gets: (path) => state.requests.filter((r) => r === `GET /api/v1${path}`).length,
  };
  const recorder = new AbortController();
  server.events.on(
    'request:start',
    ({ request }) => {
      state.requests.push(`${request.method} ${new URL(request.url).pathname}`);
    },
    { signal: recorder.signal },
  );
  onTestFinished(() => recorder.abort());

  server.use(
    http.get(`${API}/share/tok`, () => HttpResponse.json(state.info)),
    http.get(`${API}/share/tok/comments`, () =>
      state.info.allow_comments
        ? HttpResponse.json(fx.page(state.threads))
        : apiError(403, 'forbidden', 'Comments are turned off for this share link.'),
    ),
    http.post(`${API}/share/tok/comments`, async ({ request }) => {
      const body = (await request.json()) as { guest_name: string; body: string; anchor: Anchor };
      state.created.push(body);
      const n = state.created.length;
      const thread = sharedThread({
        id: `cmt_new${n}`,
        n: state.info.version_number,
        author: guest(body.guest_name),
        body: body.body,
        anchor: body.anchor,
        created_at: Date.now(),
      });
      state.threads = [...state.threads, thread];
      return HttpResponse.json(
        { thread, comment_id: thread.id, guest_token: `gt_${n}` },
        { status: 201 },
      );
    }),
    http.patch(`${API}/share/tok/comments/:id`, async ({ params, request }) => {
      const id = String(params.id);
      const body = (await request.json()) as { body: string };
      state.edits.push({ id, body, guestToken: request.headers.get('x-pinwall-guest-token') });
      const thread = state.threads.find((th) => th.id === id);
      if (thread === undefined) return apiError(404, 'not_found', 'No such comment.');
      const edited: Comment = {
        id: thread.id,
        thread_id: thread.thread_id,
        artifact_id: thread.artifact_id,
        version: thread.version,
        author: thread.author,
        body: body.body,
        created_at: thread.created_at,
        updated_at: Date.now(),
        edited_at: Date.now(),
      };
      return HttpResponse.json(edited);
    }),
  );
  return state;
}

/** Share info answers `status` with a Pinwall error body. */
function shareFails(status: number, code: string, message: string, details?: object) {
  server.use(
    http.get(`${API}/share/tok`, () =>
      apiError(status, code, message, details as Record<string, unknown> | undefined),
    ),
  );
}

const frameOf = async (n: number, name = 'Pricing') =>
  (await screen.findByTitle(`${name}, v${n}`, {}, TIMEOUT)) as HTMLIFrameElement;

/** The stream the share viewer opened last. */
function stream(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error('No live stream was opened');
  return source;
}

function emit(e: LiveEvent): void {
  act(() => stream().emit(e.type, JSON.stringify(e)));
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

test('a locked link asks for the password, then reloads the link', async () => {
  shareFails(401, 'unauthorized', 'Enter the password to open this link.', {
    password_required: true,
  });
  let sent: unknown = null;
  server.use(
    http.post(`${API}/share/tok/unlock`, async ({ request }) => {
      sent = await request.json();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  const { user } = renderRoute('/s/tok', { me: null });

  expect(
    await screen.findByRole('heading', { level: 1, name: 'This link is protected' }, TIMEOUT),
  ).toBeInTheDocument();
  expect(document.title).toBe('This link is protected · Pinwall');
  await user.type(screen.getByLabelText('Password'), 'Mật khẩu 1');
  await user.click(screen.getByRole('button', { name: 'Unlock' }));

  await waitFor(() => expect(assign).toHaveBeenCalledWith('/s/tok'), TIMEOUT);
  expect(sent).toEqual({ password: 'Mật khẩu 1' });
});

test('a wrong password and rate limits show the server message', async () => {
  shareFails(401, 'unauthorized', 'Enter the password to open this link.', {
    password_required: true,
  });
  const answers = [
    () => apiError(401, 'invalid_credentials', 'Wrong password.'),
    () => apiError(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.'),
  ];
  server.use(http.post(`${API}/share/tok/unlock`, () => (answers.shift() ?? answers[0])?.()));
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  const { user } = renderRoute('/s/tok', { me: null });

  const field = await screen.findByLabelText('Password', {}, TIMEOUT);
  // Nothing typed: nothing sent.
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(await screen.findByText(t('web.share.password.required'), {}, TIMEOUT)).toBeVisible();

  await user.type(field, 'guess');
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(await screen.findByText('Wrong password.', {}, TIMEOUT)).toBeInTheDocument();
  expect(field).toHaveAttribute('aria-invalid', 'true');

  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(
    await screen.findByText('Too many attempts. Try again in 15 minutes.', {}, TIMEOUT),
  ).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

test('gone and unknown links say so', async () => {
  const cases = [
    {
      status: 410,
      code: 'gone',
      message: 'This share link has expired. Ask the person who shared it for a new one.',
      details: { reason: 'expired' },
      title: t('share.expired.title'),
    },
    {
      status: 410,
      code: 'gone',
      message: 'This share link was revoked, or what it shared was deleted.',
      details: { reason: 'revoked' },
      title: t('share.gone.title'),
    },
    {
      status: 404,
      code: 'not_found',
      message: 'This share link does not exist.',
      details: undefined,
      title: t('share.notFound.title'),
    },
  ];
  for (const c of cases) {
    shareFails(c.status, c.code, c.message, c.details);
    renderRoute('/s/tok', { me: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: c.title }, TIMEOUT),
    ).toBeInTheDocument();
    expect(screen.getByText(c.message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(document.title).toBe(`${c.title} · Pinwall`);
    cleanup();
  }
});

test('other failures offer Retry', async () => {
  let fail = true;
  server.use(
    http.get(`${API}/share/tok`, () =>
      fail ? apiError(503, 'unavailable', 'Pinwall is restarting.') : HttpResponse.json(pricing(3)),
    ),
    http.get(`${API}/share/tok/comments`, () => HttpResponse.json(fx.page([]))),
  );
  const { user } = renderRoute('/s/tok', { me: null });
  expect(await screen.findByText('Pinwall is restarting.', {}, TIMEOUT)).toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await frameOf(3)).toHaveAttribute('src', grantUrl(3));
});

test('the viewer frames the shared page with a minimal bar', async () => {
  const s = serveShare({ info: pricing(3) });
  renderRoute('/s/tok', { me: null });

  const frame = await frameOf(3);
  expect(frame).toHaveAttribute('src', grantUrl(3));
  expect(frame.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.hasAttribute('srcdoc')).toBe(false);

  const bar = screen.getByRole('banner');
  expect(within(bar).getByRole('heading', { level: 1, name: 'Pricing' })).toBeInTheDocument();
  expect(within(bar).getByText('v3')).toBeInTheDocument();
  expect(within(bar).getByText('Latest')).toBeInTheDocument();
  const original = within(bar).getByRole('link', { name: 'Open original' });
  expect(original).toHaveAttribute('href', ORIGINAL);
  expect(original).toHaveAttribute('target', '_blank');
  expect(original.getAttribute('rel')).toContain('noreferrer');
  expect(within(bar).getByRole('button', { name: 'Comment mode' })).toBeInTheDocument();
  expect(within(bar).getByRole('button', { name: /^Comments/ })).toBeInTheDocument();
  expect(document.title).toBe('Pricing · Pinwall');

  // No app around it: no sidebar, no navigation, no account.
  expect(screen.queryByRole('button', { name: 'Open sidebar' })).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  await screen.findByRole('region', { name: 'Comments' }, TIMEOUT);
  expect(stream().url).toBe('http://localhost:3000/api/v1/share/tok/events');
  expect(s.requests.filter((r) => r.startsWith('GET /api/v1/me'))).toEqual([]);
  expect(s.requests.every((r) => r.includes('/api/v1/share/tok'))).toBe(true);

  const robots = document.head.querySelector('meta[name="robots"]');
  expect(robots?.getAttribute('content')).toBe('noindex, nofollow');
});

test('guests comment under their name', async () => {
  const s = serveShare({ info: pricing(3) });
  const { user } = renderRoute('/s/tok', { me: null });
  const top = simFrame((await frameOf(3)).contentWindow as Window);
  top.ready();

  await user.click(await screen.findByRole('button', { name: 'Add comment' }, TIMEOUT));
  const dialog = await screen.findByRole('dialog', { name: 'Add your name' }, TIMEOUT);
  const nameBox = within(dialog).getByRole('textbox', { name: 'Your name' });
  expect(nameBox).toHaveAccessibleDescription(
    'Shown next to your comments to everyone with this link.',
  );
  // A blank name is not a name.
  await user.type(nameBox, '   ');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(t('web.guest.nameRequired'), {}, TIMEOUT)).toBeVisible();
  await user.clear(nameBox);
  await user.type(nameBox, 'Lan');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), TIMEOUT);
  expect(screen.getByRole('button', { name: 'Comment mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(localStorage.getItem('pinwall:guest-name')).toBe('Lan');

  const anchor = quoteOf('Pricing');
  top.picked(anchor, { x: 200, y: 120 });
  await user.type(await screen.findByRole('textbox', { name: 'Comment' }, TIMEOUT), 'Đẹp');
  await user.click(screen.getByRole('button', { name: 'Comment' }));

  const card = await screen.findByRole('article', { name: 'Comment 1 by Lan' }, TIMEOUT);
  expect(within(card).getByText('Guest')).toBeInTheDocument();
  expect(within(card).getByText('Đẹp')).toBeInTheDocument();
  expect(s.created).toEqual([{ guest_name: 'Lan', body: 'Đẹp', anchor }]);
  expect(sessionStorage.getItem('pinwall:guest-token:cmt_new1')).toBe('gt_1');
  expect(localStorage.getItem('pinwall:guest-token:cmt_new1')).toBeNull();

  // The panel says who is commenting, and the name can change.
  const panel = screen.getByRole('region', { name: 'Comments' });
  expect(within(panel).getByText(/Commenting as Lan/)).toBeInTheDocument();
  await user.click(within(panel).getByRole('button', { name: 'Change' }));
  const change = await screen.findByRole('dialog', { name: 'Change your name' }, TIMEOUT);
  const again = within(change).getByRole('textbox', { name: 'Your name' });
  expect(again).toHaveValue('Lan');
  await user.clear(again);
  await user.type(again, 'Lan Anh');
  await user.click(within(change).getByRole('button', { name: 'Save' }));
  expect(await within(panel).findByText(/Commenting as Lan Anh/, {}, TIMEOUT)).toBeVisible();
  expect(localStorage.getItem('pinwall:guest-name')).toBe('Lan Anh');
});

test('a first pick asks for the name, then opens the composer there', async () => {
  const s = serveShare({ info: pricing(3) });
  const { user } = renderRoute('/s/tok', { me: null });
  const top = simFrame((await frameOf(3)).contentWindow as Window);
  top.ready();

  await user.click(await screen.findByRole('button', { name: 'Comment mode' }, TIMEOUT));
  top.picked(pointAt(0.5, 0.5), { x: 300, y: 200 });
  const dialog = await screen.findByRole('dialog', { name: 'Add your name' }, TIMEOUT);
  await user.type(within(dialog).getByRole('textbox', { name: 'Your name' }), 'Minh');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  const box = await screen.findByRole('textbox', { name: 'Comment' }, TIMEOUT);
  await waitFor(() => expect(box).toHaveFocus(), TIMEOUT);
  await user.type(box, 'Hello');
  await user.keyboard('{Control>}{Enter}{/Control}');
  await screen.findByRole('article', { name: 'Comment 1 by Minh' }, TIMEOUT);
  expect(s.created).toEqual([{ guest_name: 'Minh', body: 'Hello', anchor: pointAt(0.5, 0.5) }]);
});

test('a first reply asks for the name; without one nothing is sent', async () => {
  const s = serveShare({ info: pricing(3), threads: [sharedThread({ id: 't1' })] });
  const replies: unknown[] = [];
  server.use(
    http.post(`${API}/share/tok/comments/t1/replies`, async ({ request }) => {
      const body = (await request.json()) as { guest_name: string; body: string };
      replies.push(body);
      const reply = fx.comment({
        id: 'cmt_r1',
        thread_id: 't1',
        version: { id: 'ver_3', number: 3 },
        author: guest(body.guest_name),
        body: body.body,
        created_at: Date.now(),
      });
      const thread = { ...s.threads[0], replies: [reply] };
      return HttpResponse.json(
        { thread, comment_id: 'cmt_r1', guest_token: 'gt_r1' },
        { status: 201 },
      );
    }),
  );
  const { user } = renderRoute('/s/tok', { me: null });
  const card = await screen.findByRole('article', { name: 'Comment 1 by Ada' }, TIMEOUT);
  await user.click(within(card).getByRole('button', { name: 'Reply' }));
  await user.type(within(card).getByRole('textbox', { name: 'Reply' }), 'Same here');
  await user.keyboard('{Control>}{Enter}{/Control}');

  // Dismissed: the reply stays unsent, with a word on why.
  let dialog = await screen.findByRole('dialog', { name: 'Add your name' }, TIMEOUT);
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(await within(card).findByText(t('web.guest.nameNeeded'), {}, TIMEOUT)).toBeVisible();
  expect(replies).toEqual([]);

  await user.click(within(card).getByRole('button', { name: 'Reply' }));
  dialog = await screen.findByRole('dialog', { name: 'Add your name' }, TIMEOUT);
  await user.type(within(dialog).getByRole('textbox', { name: 'Your name' }), 'Lan');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(replies).toEqual([{ guest_name: 'Lan', body: 'Same here' }]), TIMEOUT);
  expect(sessionStorage.getItem('pinwall:guest-token:cmt_r1')).toBe('gt_r1');
});

test('guests change their own comments for 15 minutes only and cannot resolve', async () => {
  const start = Date.UTC(2026, 10, 12, 9);
  vi.useFakeTimers({ toFake: ['Date'] });
  // 14:59 after the guest's newest comment.
  vi.setSystemTime(start + 899_000);
  const old = sharedThread({
    id: 'cmt_old',
    author: guest('Lan'),
    body: 'First',
    created_at: start - 60_000,
  });
  const mine = sharedThread({
    id: 'cmt_mine',
    author: guest('Lan'),
    body: 'Old text',
    created_at: start,
  });
  const theirs = sharedThread({ id: 'cmt_ada', body: 'Bigger heading', created_at: start + 1 });
  sessionStorage.setItem('pinwall:guest-token:cmt_old', 'gt_old');
  sessionStorage.setItem('pinwall:guest-token:cmt_mine', 'gt_mine');
  localStorage.setItem('pinwall:guest-name', 'Lan');
  const s = serveShare({ info: pricing(3), threads: [old, mine, theirs] });
  const { user } = renderRoute('/s/tok', { me: null });

  const mineCard = await screen.findByRole('article', { name: 'Comment 2 by Lan' }, TIMEOUT);
  const oldCard = screen.getByRole('article', { name: 'Comment 1 by Lan' });
  const adaCard = screen.getByRole('article', { name: 'Comment 3 by Ada' });
  // Past its 15 minutes, and someone else's: nothing to change.
  expect(within(oldCard).queryByRole('button', { name: 'Actions for comment 1' })).toBeNull();
  expect(within(adaCard).queryByRole('button', { name: 'Actions for comment 3' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();

  await user.click(within(mineCard).getByRole('button', { name: 'Actions for comment 2' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }, TIMEOUT));
  const box = await within(mineCard).findByRole('textbox', { name: 'Edit comment' }, TIMEOUT);
  await user.clear(box);
  await user.type(box, 'New text');
  await user.click(within(mineCard).getByRole('button', { name: 'Save' }));
  expect(await within(mineCard).findByText('New text', {}, TIMEOUT)).toBeInTheDocument();
  expect(s.edits).toEqual([{ id: 'cmt_mine', body: { body: 'New text' }, guestToken: 'gt_mine' }]);

  // Its 15 minutes end while the page is open: the actions go.
  vi.setSystemTime(start + 900_000);
  await waitFor(
    () =>
      expect(
        within(mineCard).queryByRole('button', { name: 'Actions for comment 2' }),
      ).not.toBeInTheDocument(),
    TIMEOUT,
  );
});

test('a link without comments shows only the page', async () => {
  const s = serveShare({ info: pricing(2, { allow_comments: false, follows_current: false }) });
  renderRoute('/s/tok', { me: null });

  const frame = await frameOf(2);
  expect(frame).toHaveAttribute('src', grantUrl(2));
  const bar = screen.getByRole('banner');
  expect(within(bar).getByText('v2')).toBeInTheDocument();
  expect(within(bar).queryByText('Latest')).not.toBeInTheDocument();
  expect(within(bar).getByRole('link', { name: 'Open original' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Comments/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Comment mode' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Comments' })).not.toBeInTheDocument();
  expect(s.gets('/share/tok/comments')).toBe(0);
});

test('a follow-current link switches when a version is published', async () => {
  const s = serveShare({ info: pricing(3) });
  renderRoute('/s/tok', { me: null });
  await frameOf(3);
  act(() => stream().open());
  expect(s.gets('/share/tok')).toBe(1);

  s.info = pricing(4);
  emit({ type: 'version.published', artifact_id: 'art_1', version_id: 'ver_4', number: 4 });

  const frame = await frameOf(4);
  expect(frame).toHaveAttribute('src', grantUrl(4));
  expect(s.gets('/share/tok')).toBe(2);
  const bar = screen.getByRole('banner');
  expect(within(bar).getByText('v4')).toBeInTheDocument();
  expect(await screen.findByText(t('web.review.live.switched', { number: 4 }))).toBeInTheDocument();
});

test('a publish while a guest writes waits for Switch', async () => {
  const s = serveShare({ info: pricing(3) });
  localStorage.setItem('pinwall:guest-name', 'Lan');
  const { user } = renderRoute('/s/tok', { me: null });
  const top = simFrame((await frameOf(3)).contentWindow as Window);
  top.ready();
  act(() => stream().open());

  await user.click(await screen.findByRole('button', { name: 'Add comment' }, TIMEOUT));
  top.picked(pointAt(0.4, 0.4), { x: 100, y: 100 });
  await user.type(await screen.findByRole('textbox', { name: 'Comment' }, TIMEOUT), 'Half');

  s.info = pricing(4);
  emit({ type: 'version.published', artifact_id: 'art_1', version_id: 'ver_4', number: 4 });
  expect(
    await screen.findByText(t('web.review.live.published', { number: 4 }), {}, TIMEOUT),
  ).toBeInTheDocument();
  expect(screen.getByTitle('Pricing, v3')).toHaveAttribute('src', grantUrl(3));
  expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Half');

  await user.click(screen.getByRole('button', { name: 'Switch' }));
  expect(await frameOf(4)).toHaveAttribute('src', grantUrl(4));
});

test('a link revoked while open says so', async () => {
  serveShare({ info: pricing(3) });
  renderRoute('/s/tok', { me: null });
  await frameOf(3);
  act(() => stream().open());

  shareFails(410, 'gone', 'This share link was revoked, or what it shared was deleted.', {
    reason: 'revoked',
  });
  emit({ type: 'artifact.deleted', artifact_id: 'art_1' });
  expect(
    await screen.findByRole('heading', { level: 1, name: t('share.gone.title') }, TIMEOUT),
  ).toBeInTheDocument();
  expect(screen.queryByTitle('Pricing, v3')).not.toBeInTheDocument();
});

test('guest and comment text render as text', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  localStorage.setItem('pinwall:guest-name', evil);
  serveShare({
    info: pricing(3, { artifact_name: `<b>${evil}</b>` }),
    threads: [sharedThread({ id: 't1', author: guest(evil), body: evil })],
  });
  renderRoute('/s/tok', { me: null });

  const card = await screen.findByRole('article', { name: `Comment 1 by ${evil}` }, TIMEOUT);
  // The name and the body, each as text.
  expect(within(card).getAllByText(evil)).toHaveLength(2);
  expect(screen.getByRole('heading', { level: 1, name: `<b>${evil}</b>` })).toBeInTheDocument();
  const panel = screen.getByRole('region', { name: 'Comments' });
  expect(within(panel).getByText(`Commenting as ${evil}`, { exact: false })).toBeInTheDocument();
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('b')).toBeNull();
});
