import type { Anchor } from '@pinwall/shared/protocol';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { type ReactNode, useMemo } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Comment, CommentThread } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { createQueryClient } from '../../api/query-client.ts';
import { fx } from '../../test/fixtures.ts';
import { API, apiError, server } from '../../test/server.ts';
import type { FrameBridge, PickedAnchor, PinPlacement } from '../frame/use-frame-bridge.ts';
import type { StreamStatus } from '../live/event-stream.ts';
import { memberBackend, memberPermissions, type Permissions } from './backend.ts';
import { CommentPanel } from './comment-panel.tsx';
import { CommentSheet } from './comment-sheet.tsx';
import { Composer } from './composer.tsx';
import { composerFloats } from './composer-position.ts';
import { type ReviewComments, useReviewComments } from './use-review-comments.ts';

const PREF = 'pinwall:comment-filter:usr_1';
const NO_ANNOTATOR =
  "This page blocks Pinwall's comment helper, so comments can only be pinned to a spot on the screen, and they don't move when the page scrolls.";

const ME = fx.me({ id: 'usr_1', name: 'Ada' });
const ada = { type: 'member', user_id: 'usr_1', name: 'Ada' } as const;
const v = (n: number) => ({ id: `ver_${n}`, number: n });

function textAnchor(page: string, exact: string): Anchor {
  return {
    page,
    kind: 'text',
    quote: { exact, prefix: 'alpha ', suffix: ' delta' },
    position: { x: 0.2, y: 0.3 },
    viewport: { width: 1280 },
  };
}

const t1 = fx.thread({
  id: 't1',
  author: ada,
  version: v(1),
  created_at: 1,
  body: 'Bigger heading',
  anchor: textAnchor('docs/', 'beta gamma'),
});
const t2 = fx.thread({
  id: 't2',
  author: ada,
  version: v(1),
  created_at: 2,
  body: 'Swap the photo',
  status: 'resolved',
  resolved_in_version: v(2),
  resolved_by: { user_id: 'usr_1', name: 'Ada' },
  resolved_at: 3,
});
const t3 = fx.thread({
  id: 't3',
  author: { type: 'guest', name: 'Lan' },
  version: v(2),
  created_at: 3,
  body: 'Màu nền tối quá',
});
/** Written on v4, newer than the v3 the panel shows. */
const t4 = fx.thread({ id: 't4', author: ada, version: v(4), created_at: 4, body: 'Later' });

/** The fields a thread shares with each of its comments: what PATCH answers. */
function commentOf(t: CommentThread): Comment {
  const { anchor, status, resolved_in_version, resolved_by, resolved_at, replies, ...comment } = t;
  return comment;
}

const nestedPick: PickedAnchor = {
  anchor: textAnchor('', 'Pricing'),
  frameId: 'nested-1',
  topFrame: false,
  client: null,
};
const topPick: PickedAnchor = {
  anchor: { page: '', kind: 'point', position: { x: 0.1, y: 0.1 }, viewport: { width: 1280 } },
  frameId: 'top-1',
  topFrame: true,
  client: { x: 100, y: 50 },
};

/** The comments the harness rendered last. */
let c: ReviewComments;

function Harness({
  bridge,
  permissions,
  liveStatus,
  onPosted,
  footer,
}: {
  bridge: FrameBridge;
  permissions: Permissions;
  liveStatus: StreamStatus;
  onPosted(t: CommentThread): void;
  footer?: ReactNode;
}) {
  const backend = useMemo(() => memberBackend('art_1'), []);
  c = useReviewComments({
    backend,
    permissions,
    shown: 3,
    versionId: 'ver_3',
    filterPrefKey: PREF,
  });
  return (
    <>
      <CommentPanel
        c={c}
        bridge={bridge}
        shown={3}
        variant="dock"
        liveStatus={liveStatus}
        onAddComment={() => {}}
        onClose={() => {}}
        footer={footer}
      />
      {/* What the review page does for a pick in the top frame: float the composer beside it. */}
      {c.draft && composerFloats(c.draft, 'dock') ? (
        <Composer
          c={c}
          number={c.shownAll.length + 1}
          floating={{ left: 168, top: 114 }}
          onPosted={onPosted}
        />
      ) : null}
    </>
  );
}

function stubBridge(o: {
  annotator?: FrameBridge['annotator'];
  placements?: Record<string, PinPlacement>;
}): FrameBridge {
  return {
    src: 'https://content.example/g/grant-1/',
    frameRef: () => {},
    onFrameLoad: () => {},
    loading: false,
    annotator: o.annotator ?? 'ready',
    topPage: '',
    placement: (pin) => o.placements?.[pin.id] ?? 'placed',
    focus: vi.fn(),
    navigate: vi.fn(),
    scrollTo: vi.fn(),
  };
}

function setup(
  o: {
    threads?: CommentThread[];
    list?: () => Response;
    filter?: 'open' | 'resolved' | 'all';
    permissions?: Permissions;
    annotator?: FrameBridge['annotator'];
    placements?: Record<string, PinPlacement>;
    liveStatus?: StreamStatus;
    footer?: ReactNode;
  } = {},
) {
  if (o.filter) localStorage.setItem(PREF, o.filter);
  const threads = o.threads ?? [t1, t2, t3, t4];
  server.use(
    http.get(`${API}/artifacts/art_1/comments`, () =>
      o.list ? o.list() : HttpResponse.json(fx.page(threads)),
    ),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const bridge = stubBridge(o);
  const onPosted = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness
        bridge={bridge}
        permissions={o.permissions ?? memberPermissions(ME, { created_by: 'usr_1' })}
        liveStatus={o.liveStatus ?? 'open'}
        onPosted={onPosted}
        footer={o.footer}
      />
    </QueryClientProvider>,
  );
  return { user, bridge, queryClient, onPosted, unmount: view.unmount };
}

const card = (name: string) => screen.findByRole('article', { name });
const cardNames = () => screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label'));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test('threads show number, author, version, quote and status', async () => {
  const t5 = fx.thread({
    id: 't5',
    author: ada,
    version: v(3),
    created_at: 5,
    body: 'Done',
    status: 'resolved',
    resolved_in_version: null,
    resolved_by: { user_id: 'usr_1', name: 'Ada' },
    resolved_at: 6,
  });
  const { user, bridge } = setup({
    threads: [t1, t2, t3, t4, t5],
    filter: 'all',
    placements: { t1: 'elsewhere', t3: 'detached' },
  });

  const first = await card('Comment 1 by Ada');
  expect(within(first).getByText('1')).toBeInTheDocument();
  expect(within(first).getByText('v1')).toBeInTheDocument();
  expect(within(first).getByText('beta gamma')).toBeInTheDocument();
  expect(within(first).getByText('Bigger heading')).toBeInTheDocument();
  await user.click(within(first).getByRole('button', { name: 'On docs/' }));
  expect(bridge.focus).toHaveBeenCalledWith('t1');

  const second = screen.getByRole('article', { name: 'Comment 2 by Ada' });
  expect(within(second).getByText('Resolved in v2')).toBeInTheDocument();
  expect(within(second).queryByText(/Couldn't find/)).not.toBeInTheDocument();

  const third = screen.getByRole('article', { name: 'Comment 3 by Lan' });
  expect(within(third).getByText('Guest')).toBeInTheDocument();
  expect(within(third).getByText('v2')).toBeInTheDocument();
  expect(within(third).getByText("Couldn't find this on v3")).toBeInTheDocument();
  expect(within(third).getByText('Màu nền tối quá')).toBeInTheDocument();

  const fourth = screen.getByRole('article', { name: 'Comment 4 by Ada' });
  expect(within(fourth).getByText('Resolved')).toBeInTheDocument();

  // t4 was written on v4, after the version shown.
  expect(cardNames()).toEqual([
    'Comment 1 by Ada',
    'Comment 2 by Ada',
    'Comment 3 by Lan',
    'Comment 4 by Ada',
  ]);
});

test('the filter counts and filters, and remembers the choice', async () => {
  const { user } = setup();
  const filter = screen.getByRole('radiogroup', { name: 'Filter comments' });
  const open = await within(filter).findByRole('radio', { name: 'Open (2)' });
  expect(open).toHaveAttribute('aria-checked', 'true');
  expect(cardNames()).toEqual(['Comment 1 by Ada', 'Comment 3 by Lan']);
  expect(c.pins.map((p) => [p.id, p.number])).toEqual([
    ['t1', 1],
    ['t3', 3],
  ]);

  await user.click(within(filter).getByRole('radio', { name: 'Resolved (1)' }));
  expect(cardNames()).toEqual(['Comment 2 by Ada']);

  await user.click(within(filter).getByRole('radio', { name: 'All' }));
  expect(cardNames()).toHaveLength(3);
  expect(localStorage.getItem(PREF)).toBe('all');
});

test('a thread resolved while open stays listed until the filter changes', async () => {
  const { user } = setup();
  await card('Comment 1 by Ada');

  act(() =>
    c.applyLive({
      type: 'comment.resolved',
      artifact_id: 'art_1',
      thread: {
        ...t1,
        status: 'resolved',
        resolved_in_version: v(2),
        resolved_by: { user_id: 'usr_2', name: 'Bao' },
        resolved_at: 9,
      },
    }),
  );
  const resolved = screen.getByRole('article', { name: 'Comment 1 by Ada' });
  expect(await within(resolved).findByText('Resolved in v2')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Open (1)' })).toHaveAttribute('aria-checked', 'true');
  expect(c.pins.find((p) => p.id === 't1')?.resolved).toBe(true);

  await user.click(screen.getByRole('radio', { name: 'All' }));
  await user.click(screen.getByRole('radio', { name: 'Open (1)' }));
  expect(cardNames()).toEqual(['Comment 3 by Lan']);
});

test('reply, resolve, reopen, edit and delete', async () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const record = async (request: Request) => {
    const text = await request.text();
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text === '' ? null : JSON.parse(text),
    });
  };
  const reply = fx.comment({
    id: 'r1',
    thread_id: 't1',
    author: ada,
    version: v(3),
    body: 'Đã sửa',
    created_at: 10,
    updated_at: 10,
  });
  server.use(
    http.post(`${API}/comments/t1/replies`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(reply, { status: 201 });
    }),
    http.post(`${API}/comments/t1/resolve`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        ...t1,
        replies: [reply],
        status: 'resolved',
        resolved_in_version: v(3),
        resolved_by: { user_id: 'usr_1', name: 'Ada' },
        resolved_at: 11,
      });
    }),
    http.post(`${API}/comments/t1/reopen`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ ...t1, replies: [reply] });
    }),
    http.patch(`${API}/comments/t1`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ ...commentOf(t1), body: 'Much bigger heading', edited_at: 12 });
    }),
    http.delete(`${API}/comments/t1`, async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const first = setup({ filter: 'all' });
  const { user } = first;
  const thread = await card('Comment 1 by Ada');

  // An unselected thread offers a Reply button; it opens the box, focused, and selects the thread.
  expect(within(thread).queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
  await user.click(within(thread).getByRole('button', { name: 'Reply' }));
  const box = within(thread).getByRole('textbox', { name: 'Reply' });
  await waitFor(() => expect(box).toHaveFocus());
  expect(thread).toHaveAttribute('aria-current', 'true');
  await user.type(box, 'Đã sửa');
  await user.click(within(thread).getByRole('button', { name: 'Reply' }));
  expect(await within(thread).findByText('Đã sửa')).toBeInTheDocument();
  expect(within(thread).getByRole('textbox', { name: 'Reply' })).toHaveValue('');

  await user.click(within(thread).getByRole('button', { name: 'Resolve' }));
  expect(await within(thread).findByText('Resolved in v3')).toBeInTheDocument();
  await user.click(within(thread).getByRole('button', { name: 'Reopen' }));
  await waitFor(() => expect(within(thread).queryByText('Resolved in v3')).not.toBeInTheDocument());
  expect(within(thread).getByRole('button', { name: 'Resolve' })).toBeInTheDocument();

  await user.click(within(thread).getByRole('button', { name: 'Actions for comment 1' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  const edit = within(thread).getByRole('textbox', { name: 'Edit comment' });
  expect(edit).toHaveValue('Bigger heading');
  await user.clear(edit);
  await user.type(edit, 'Much bigger heading');
  await user.click(within(thread).getByRole('button', { name: 'Save' }));
  expect(await within(thread).findByText('Much bigger heading')).toBeInTheDocument();
  expect(within(thread).getByText('edited')).toBeInTheDocument();

  await user.click(within(thread).getByRole('button', { name: 'Actions for comment 1' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  const confirm = await screen.findByRole('alertdialog', { name: 'Delete this comment?' });
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
  // The pins number again from 1: the card is gone, not just renumbered.
  await waitFor(() => expect(document.querySelector('[data-thread-id="t1"]')).toBeNull());
  expect(cardNames()).toEqual(['Comment 1 by Ada', 'Comment 2 by Lan']);

  expect(requests).toEqual([
    { method: 'POST', path: '/api/v1/comments/t1/replies', body: { body: 'Đã sửa' } },
    { method: 'POST', path: '/api/v1/comments/t1/resolve', body: { version_id: 'ver_3' } },
    { method: 'POST', path: '/api/v1/comments/t1/reopen', body: null },
    { method: 'PATCH', path: '/api/v1/comments/t1', body: { body: 'Much bigger heading' } },
    { method: 'DELETE', path: '/api/v1/comments/t1', body: null },
  ]);
  first.unmount();

  // Someone who may only read: no reply box, no Resolve, and the menu holds only Copy link.
  const reader = setup({
    filter: 'all',
    permissions: {
      canComment: false,
      canResolve: false,
      needsGuestName: false,
      canEdit: () => false,
      canDelete: () => false,
    },
  });
  // After setup: user-event puts its own clipboard on navigator.
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const readOnly = await card('Comment 1 by Ada');
  expect(within(readOnly).queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
  await reader.user.click(within(readOnly).getByText('Bigger heading'));
  expect(readOnly).toHaveAttribute('aria-current', 'true');
  expect(within(readOnly).queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
  expect(within(readOnly).queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  const resolvedCard = screen.getByRole('article', { name: 'Comment 2 by Ada' });
  expect(within(resolvedCard).queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  await reader.user.click(within(readOnly).getByRole('button', { name: 'Actions for comment 1' }));
  const menu = await screen.findByRole('menu');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Copy link']);
  await reader.user.click(within(menu).getByRole('menuitem', { name: 'Copy link' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/a/art_1?comment=t1`),
  );
});

test('the composer posts on the shown version and selects the new thread', async () => {
  let posted: unknown;
  const created = fx.thread({
    id: 't9',
    author: ada,
    version: v(3),
    created_at: 20,
    body: 'Bigger title',
    anchor: nestedPick.anchor,
  });
  server.use(
    http.post(`${API}/artifacts/art_1/comments`, async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json(created, { status: 201 });
    }),
  );
  const { user, bridge, queryClient } = setup();
  queryClient.setQueryData(qk.artifact('art_1'), fx.artifact());
  await card('Comment 1 by Ada');

  // A pick inside a nested frame has no point beside which to float: the composer heads the panel.
  act(() => c.startDraft(nestedPick));
  expect(c.pins.at(-1)).toEqual({
    id: 'draft',
    number: 4,
    resolved: false,
    anchor: nestedPick.anchor,
  });
  const panel = screen.getByRole('region', { name: 'Comments' });
  const form = within(panel).getByRole('form', { name: 'New comment' });
  expect(within(form).getByText('4')).toBeInTheDocument();
  expect(within(form).getByText('Pricing')).toBeInTheDocument();
  const box = within(form).getByRole('textbox', { name: 'Comment' });
  await waitFor(() => expect(box).toHaveFocus());

  await user.type(box, 'Bigger title');
  expect(c.composing).toBe(true);
  await user.keyboard('{Control>}{Enter}{/Control}');

  const fresh = await card('Comment 4 by Ada');
  expect(posted).toEqual({ body: 'Bigger title', anchor: nestedPick.anchor, version_id: 'ver_3' });
  expect(fresh).toHaveAttribute('aria-current', 'true');
  expect(c.selectedId).toBe('t9');
  expect(c.draft).toBeNull();
  expect(c.composing).toBe(false);
  expect(c.pins.map((p) => p.id)).toEqual(['t1', 't3', 't9']);
  expect(screen.queryByRole('form', { name: 'New comment' })).not.toBeInTheDocument();
  expect(bridge.focus).toHaveBeenCalledWith('t9');
  // Library cards show open-thread counts: the artifact must be read again.
  expect(queryClient.getQueryState(qk.artifact('art_1'))?.isInvalidated).toBe(true);

  // A pick in the top frame floats beside its point, outside the panel.
  act(() => c.startDraft(topPick));
  const floating = await screen.findByRole('form', { name: 'New comment' });
  expect(within(panel).queryByRole('form')).not.toBeInTheDocument();
  expect(floating).toHaveStyle({ position: 'fixed', left: '168px', top: '114px' });
  expect(within(floating).getByText('5')).toBeInTheDocument();
});

test('a failed post keeps the draft', async () => {
  server.use(
    http.post(`${API}/artifacts/art_1/comments`, () =>
      apiError(410, 'version_gone', 'This version was deleted and is no longer available.'),
    ),
  );
  const { user } = setup();
  await card('Comment 1 by Ada');
  act(() => c.startDraft(nestedPick));
  const box = screen.getByRole('textbox', { name: 'Comment' });
  await user.type(box, 'Bigger title');
  await user.click(screen.getByRole('button', { name: 'Comment' }));

  const form = screen.getByRole('form', { name: 'New comment' });
  expect(await within(form).findByRole('alert')).toHaveTextContent(
    'This version was deleted and is no longer available.',
  );
  expect(box).toHaveValue('Bigger title');
  expect(c.draft).not.toBeNull();
  expect(c.composing).toBe(true);
});

test('Escape closes only an empty composer', async () => {
  const { user } = setup();
  await card('Comment 1 by Ada');
  act(() => c.startDraft(topPick));
  const box = await screen.findByRole('textbox', { name: 'Comment' });
  await waitFor(() => expect(box).toHaveFocus());

  await user.type(box, 'x');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('form', { name: 'New comment' })).toBeInTheDocument();

  await user.clear(box);
  await user.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('form', { name: 'New comment' })).not.toBeInTheDocument(),
  );
  expect(c.draft).toBeNull();

  // Cancel discards the text, whatever it holds.
  act(() => c.startDraft(topPick));
  await user.type(await screen.findByRole('textbox', { name: 'Comment' }), 'Never mind');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(c.draft).toBeNull();
  act(() => c.startDraft(topPick));
  expect(await screen.findByRole('textbox', { name: 'Comment' })).toHaveValue('');
});

test('composing covers new comments, replies and edits', async () => {
  const { user } = setup();
  const thread = await card('Comment 1 by Ada');
  expect(c.composing).toBe(false);

  await user.click(within(thread).getByRole('button', { name: 'Reply' }));
  const reply = within(thread).getByRole('textbox', { name: 'Reply' });
  await user.type(reply, 'a');
  expect(c.composing).toBe(true);
  await user.clear(reply);
  expect(c.composing).toBe(false);

  await user.click(within(thread).getByRole('button', { name: 'Actions for comment 1' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  await waitFor(() => expect(c.composing).toBe(true));
  await user.click(within(thread).getByRole('button', { name: 'Cancel' }));
  expect(c.composing).toBe(false);
  expect(within(thread).getByText('Bigger heading')).toBeInTheDocument();

  act(() => c.startDraft(nestedPick));
  expect(c.composing).toBe(false);
  await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'b');
  expect(c.composing).toBe(true);
});

test('clicking a card focuses its pin; the empty and error states', async () => {
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
  const first = setup();
  const thread = await card('Comment 1 by Ada');
  await first.user.click(within(thread).getByText('Bigger heading'));
  expect(first.bridge.focus).toHaveBeenCalledWith('t1');
  expect(thread).toHaveAttribute('aria-current', 'true');
  expect(scroll.mock.contexts).toContain(thread);
  expect(c.selectedId).toBe('t1');

  // From the keyboard, the pin is the card's button.
  const other = screen.getByRole('article', { name: 'Comment 3 by Lan' });
  const pin = within(other).getByRole('button', { name: 'Show comment 3 on the page' });
  act(() => pin.focus());
  await first.user.keyboard('{Enter}');
  expect(first.bridge.focus).toHaveBeenLastCalledWith('t3');
  expect(other).toHaveAttribute('aria-current', 'true');
  expect(thread).not.toHaveAttribute('aria-current');
  first.unmount();

  // A filter with nothing to show says so.
  const empty = setup({ threads: [t2], filter: 'open' });
  expect(await screen.findByText('No open comments')).toBeInTheDocument();
  empty.unmount();

  const none = setup({ threads: [] });
  expect(await screen.findByText('No comments yet')).toBeInTheDocument();
  expect(
    screen.getByText(
      'Press C or choose Add comment, then select text or click anything on the page.',
    ),
  ).toBeInTheDocument();
  none.unmount();

  let reads = 0;
  const failing = setup({
    list: () => {
      reads += 1;
      return reads === 1
        ? apiError(500, 'internal', 'Pinwall ran into an unexpected problem.')
        : HttpResponse.json(fx.page([t1]));
    },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Pinwall ran into an unexpected problem.',
  );
  await failing.user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await card('Comment 1 by Ada')).toBeInTheDocument();
  expect(reads).toBe(2);
});

test('the overlay notice appears when the annotator is missing', async () => {
  const blocked = setup({ annotator: 'missing', liveStatus: 'reconnecting' });
  await card('Comment 1 by Ada');
  expect(screen.getByText(NO_ANNOTATOR)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
  blocked.unmount();

  setup();
  await card('Comment 1 by Ada');
  expect(screen.queryByText(NO_ANNOTATOR)).not.toBeInTheDocument();
  expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
});

test('a footer sits under the threads', async () => {
  setup({ footer: <p>Commenting as Lan</p> });
  const panel = await screen.findByRole('region', { name: 'Comments' });
  await card('Comment 1 by Ada');
  const footer = within(panel).getByText('Commenting as Lan');
  const list = within(panel).getByRole('list');
  expect(list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('on a phone the panel sits in a bottom sheet', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <CommentSheet open onOpenChange={onOpenChange} title="Comments">
      <p>Thread list</p>
      <textarea aria-label="Draft" />
    </CommentSheet>,
  );
  const sheet = await screen.findByRole('dialog', { name: 'Comments' });
  expect(within(sheet).getByText('Thread list')).toBeInTheDocument();

  // Escape in a box holding text is that box's to handle; it does not hide the sheet.
  await user.type(within(sheet).getByRole('textbox', { name: 'Draft' }), 'Unsent');
  await user.keyboard('{Escape}');
  expect(onOpenChange).not.toHaveBeenCalled();

  await user.click(within(sheet).getByRole('button', { name: 'Close comments' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
