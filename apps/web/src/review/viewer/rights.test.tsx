import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { ArtifactSummary, CommentThread, LiveEvent, Project } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import i18n from '../../i18n.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { serveReview, threadOn } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';
import { BOB, fxOwn, fxShared, PERSONAL } from '../../test/spaces.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);

/** The signed-in person: a member, so nothing comes from being an admin. */
const me = fx.me({ role: 'member' });

/** What the menu offers anyone who may change nothing, on a version that is not the current one. */
const READ_ONLY_ITEMS = [
  'Open raw page',
  'Copy review link',
  'Copy raw link',
  'Full screen',
  'Keyboard shortcuts',
];

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/**
 * The review of "Pricing" (`art_1`, versions `versions`, default 3/2/1) in project `prj_1`:
 * the artifact as `artifact` overrides it (by default Bob published it), version n published by
 * `by(n)` (default Bob), `threads`, and `GET /projects/prj_1` answered by `project`.
 */
function serveSpace(o: {
  project: Project | (() => Promise<Response>);
  artifact?: Partial<ArtifactSummary>;
  versions?: number[];
  by?: (n: number) => string;
  threads?: CommentThread[];
}) {
  const s = serveReview({ versions: o.versions, threads: o.threads });
  const by = o.by ?? (() => BOB.id);
  s.versions = s.versions.map((v) => ({ ...v, created_by: by(v.number) }));
  // Publishing the newest again settles the artifact's current version on these publishers.
  const newest = s.versions[0];
  if (newest) s.publish(newest.number);
  const { project } = o;
  server.use(
    http.get(`${API}/artifacts/art_1`, () =>
      HttpResponse.json({ ...s.artifact, project_id: 'prj_1', created_by: BOB.id, ...o.artifact }),
    ),
    http.get(`${API}/projects/prj_1`, () =>
      typeof project === 'function' ? project() : HttpResponse.json(project),
    ),
  );
  return s;
}

/** The accessible text of a menu item: its label, without the icon and the key hint. */
const labelOf = (item: HTMLElement) =>
  item.querySelector('span:not([aria-hidden])')?.textContent ?? item.textContent;

async function openMenu(user: UserEvent): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  return screen.findByRole('menu');
}

async function closeMenu(user: UserEvent): Promise<void> {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}

const menuLabels = async (user: UserEvent) => {
  const labels = within(await openMenu(user))
    .getAllByRole('menuitem')
    .map(labelOf);
  await closeMenu(user);
  return labels;
};

/** Opens and closes the version menu, which shows once the version list is read. */
async function versionsRead(user: UserEvent, n: number): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^Choose version/ }));
  await screen.findByRole('menuitemradio', { name: new RegExp(`^v${n}`) });
  await closeMenu(user);
}

/** Waits until the project is read: the breadcrumb then links to it. */
async function projectRead(): Promise<void> {
  const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
  await within(breadcrumb).findByRole('link', { name: 'Launch site' });
}

/** Whether the comment by `name` offers Delete in its menu; leaves the menu closed. */
async function mayDeleteCommentBy(user: UserEvent, name: string): Promise<boolean> {
  const card = await screen.findByRole('article', { name: new RegExp(` by ${name}$`) });
  await user.click(within(card).getByRole('button', { name: /^Actions for comment/ }));
  const menu = await screen.findByRole('menu');
  const found = within(menu).queryByRole('menuitem', { name: 'Delete' }) !== null;
  await closeMenu(user);
  return found;
}

/** A thread on version 2 by `author`. */
const threadBy = (id: string, author: { id: string; name: string }, at: number) =>
  threadOn(2, {
    id,
    created_at: at,
    author: { type: 'member', user_id: author.id, name: author.name },
  });

test('a viewer gets no Restore and no Delete in the review menu', async () => {
  // They published it while they could; as a viewer they change nothing.
  serveSpace({
    project: fxShared('viewer'),
    artifact: { created_by: me.id, can_manage: false },
    by: () => me.id,
  });
  const { user } = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  await screen.findByTitle('Pricing, v2');
  await projectRead();
  await versionsRead(user, 2);

  const menu = await openMenu(user);
  expect(within(menu).getAllByRole('menuitem').map(labelOf)).toEqual(READ_ONLY_ITEMS);
  expect(within(menu).queryByRole('separator')).not.toBeInTheDocument();
});

test('an editor deletes only versions they published, never the last one of an artifact they did not publish', async () => {
  const s = serveSpace({
    project: fxShared('editor'),
    artifact: { created_by: BOB.id, can_manage: false },
    versions: [2, 1],
    by: (n) => (n === 2 ? me.id : BOB.id),
  });
  const { user, router } = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  await screen.findByTitle('Pricing, v2');
  await projectRead();
  await versionsRead(user, 2);

  // Their own v2 goes; Bob's artifact stays.
  let labels = await menuLabels(user);
  expect(labels).toContain(t('web.review.deleteVersion.item', { number: 2 }));
  expect(labels).not.toContain('Delete artifact…');

  // Bob's v1 is not theirs to delete, though an editor may restore it.
  await act(() => router.navigate('/a/art_1/v/1'));
  await screen.findByTitle('Pricing, v1');
  labels = await menuLabels(user);
  expect(labels).not.toContain(t('web.review.deleteVersion.item', { number: 1 }));
  expect(labels).toContain('Restore v1 as the current version');

  // Bob deletes v1: v2 is now the artifact's last version, which goes only with the artifact.
  await act(() => router.navigate('/a/art_1/v/2'));
  await screen.findByTitle('Pricing, v2');
  const stream = FakeEventSource.instances.at(-1);
  if (stream === undefined) throw new Error('No live stream was opened');
  act(() => stream.open());
  const reads = s.gets('/artifacts/art_1/versions');
  s.remove(1);
  const deleted: LiveEvent = { type: 'version.deleted', artifact_id: 'art_1', number: 1 };
  act(() => stream.emit(deleted.type, JSON.stringify(deleted)));
  await waitFor(() => expect(s.gets('/artifacts/art_1/versions')).toBeGreaterThan(reads));
  await user.click(screen.getByRole('button', { name: /^Choose version/ }));
  await waitFor(() =>
    expect(screen.queryByRole('menuitemradio', { name: /^v1/ })).not.toBeInTheDocument(),
  );
  await closeMenu(user);

  labels = await menuLabels(user);
  expect(labels).not.toContain(t('web.review.deleteVersion.item', { number: 2 }));
  expect(labels).not.toContain('Delete artifact…');
});

test("the project owner deletes anyone's comment; an editor only their own", async () => {
  const threads = [threadBy('cmt_b', BOB, 1), threadBy('cmt_m', me, 2)];
  // Bob published into the owner's project.
  serveSpace({
    project: fxOwn(),
    artifact: { created_by: BOB.id, can_manage: true },
    threads,
  });
  const owner = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  await projectRead();
  expect(await mayDeleteCommentBy(owner.user, BOB.name)).toBe(true);
  expect(await mayDeleteCommentBy(owner.user, me.name)).toBe(true);
  cleanup();

  // An editor who published the artifact still moderates no one.
  serveSpace({
    project: fxShared('editor'),
    artifact: { created_by: me.id, can_manage: true },
    threads,
  });
  const editor = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  await projectRead();
  expect(await mayDeleteCommentBy(editor.user, BOB.name)).toBe(false);
  expect(await mayDeleteCommentBy(editor.user, me.name)).toBe(true);
});

test('the owner revokes any link of the project; an editor only their own', async () => {
  const links = [
    fx.shareLink({ id: 'shl_m', created_by: { user_id: me.id, name: me.name } }),
    fx.shareLink({ id: 'shl_b', created_by: { user_id: BOB.id, name: BOB.name } }),
  ];
  /** Which rows of the share dialog offer Revoke, in order. */
  async function revocable(user: UserEvent): Promise<boolean[]> {
    await screen.findByTitle('Pricing, v2');
    await projectRead();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: /^Share/ });
    const rows = await within(dialog).findAllByRole('listitem');
    return rows.map((row) => within(row).queryByRole('button', { name: /^Revoke/ }) !== null);
  }
  const serveLinks = () =>
    server.use(
      http.get(`${API}/artifacts/art_1/share-links`, () => HttpResponse.json(fx.page(links))),
    );

  serveSpace({ project: fxOwn(), artifact: { created_by: BOB.id, can_manage: true } });
  serveLinks();
  const owner = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  expect(await revocable(owner.user)).toEqual([true, true]);
  cleanup();

  // Publishing the artifact gives an editor no say over Bob's link.
  serveSpace({ project: fxShared('editor'), artifact: { created_by: me.id, can_manage: true } });
  serveLinks();
  const editor = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  expect(await revocable(editor.user)).toEqual([true, false]);
});

test('nothing that changes content shows until the role is known', async () => {
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  // In team mode, publishing the artifact and every version would allow it all.
  const s = serveSpace({
    project: async () => {
      await answered;
      return HttpResponse.json(fxOwn());
    },
    artifact: { created_by: me.id, can_manage: true },
    by: () => me.id,
    threads: [threadBy('cmt_b', BOB, 1)],
  });
  const { user } = renderRoute('/a/art_1/v/2', { me, config: PERSONAL });
  await screen.findByTitle('Pricing, v2');
  await versionsRead(user, 2);
  await waitFor(() => expect(s.gets('/projects/prj_1')).toBe(1));

  expect(await menuLabels(user)).toEqual(READ_ONLY_ITEMS);
  expect(await mayDeleteCommentBy(user, BOB.name)).toBe(false);

  answer();
  await projectRead();
  const labels = await menuLabels(user);
  expect(labels).toContain('Restore v2 as the current version');
  expect(labels).toContain(t('web.review.deleteVersion.item', { number: 2 }));
  expect(labels).toContain('Delete artifact…');
  expect(await mayDeleteCommentBy(user, BOB.name)).toBe(true);
});

test('team mode keeps the 1.0 menu without waiting for the project', async () => {
  serveSpace({
    project: async () => {
      await delay('infinite');
      return HttpResponse.json(fx.project());
    },
  });
  const { user } = renderRoute('/a/art_1/v/2', { me: fx.me({ role: 'admin' }) });
  await screen.findByTitle('Pricing, v2');
  await versionsRead(user, 2);

  const labels = await menuLabels(user);
  expect(labels).toContain('Restore v2 as the current version');
  expect(labels).toContain(t('web.review.deleteVersion.item', { number: 2 }));
  expect(labels).toContain('Delete artifact…');
});

test('the shell waits for the public configuration before it shows a page', async () => {
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  server.use(
    http.get(`${API}/config/public`, async () => {
      await answered;
      return HttpResponse.json(fx.config(PERSONAL));
    }),
  );
  const s = serveSpace({
    project: fxShared('viewer'),
    artifact: { created_by: me.id, can_manage: false },
  });
  const { queryClient } = renderRoute('/a/art_1/v/2', { me });
  await waitFor(() => expect(queryClient.getQueryData(qk.me)).toEqual(me));
  // Long enough for the page to have started reading the artifact, had it been shown.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  expect(s.gets('/artifacts/art_1')).toBe(0);

  answer();
  expect(await screen.findByTitle('Pricing, v2')).toBeInTheDocument();
});

test('a public configuration that cannot be read counts as team mode', async () => {
  server.use(
    http.get(`${API}/config/public`, () =>
      apiError(500, 'internal', 'Something went wrong on the server.'),
    ),
  );
  serveSpace({
    project: async () => {
      await delay('infinite');
      return HttpResponse.json(fx.project());
    },
  });
  const { user } = renderRoute('/a/art_1/v/2', { me: fx.me({ role: 'admin' }) });
  await screen.findByTitle('Pricing, v2');
  await versionsRead(user, 2);
  expect(await menuLabels(user)).toContain('Delete artifact…');
});
