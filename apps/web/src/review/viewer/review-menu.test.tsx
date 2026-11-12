import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { Me } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { reviewer, serveReview, versionOf } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';
import { canDelete } from './review-menu.tsx';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const TIMEOUT = { timeout: 5000 };

const member = fx.me({ id: 'usr_2', name: 'Grace', role: 'member' });
const admin = fx.me({ id: 'usr_9', name: 'Root', role: 'admin' });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/** The accessible text of a menu item: its label, without the icon and the key hint. */
const labelOf = (item: HTMLElement) =>
  item.querySelector('span:not([aria-hidden])')?.textContent ?? item.textContent;

async function openMenu(user: UserEvent): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  return screen.findByRole('menu', {}, TIMEOUT);
}

/** Opens and closes the version menu, which shows once the version list is read. */
async function versionsRead(user: UserEvent, n: number): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^Choose version/ }, TIMEOUT));
  await screen.findByRole('menuitemradio', { name: new RegExp(`^v${n}`) }, TIMEOUT);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument(), TIMEOUT);
}

/** The Clipboard API, after user-event has put its own on `navigator`. */
function stubClipboard(writeText: (text: string) => Promise<void> = () => Promise.resolve()) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: spy },
  });
  return spy;
}

/** What the version and artifact routes of `art_1` answer, kept in step with `s`. */
function serveActions(s: ReturnType<typeof serveReview>) {
  const seen = { restore: [] as unknown[] };
  server.use(
    http.delete(`${API}/artifacts/art_1/versions/:n`, ({ params }) => {
      s.remove(Number(params.n));
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${API}/artifacts/art_1`, () => new HttpResponse(null, { status: 204 })),
    http.post(`${API}/artifacts/art_1/versions/:n/restore`, async ({ request }) => {
      seen.restore.push(await request.json());
      const next = Math.max(...s.versions.map((v) => v.number)) + 1;
      s.publish(next);
      return HttpResponse.json(versionOf(next), { status: 201 });
    }),
    // The project page the deletion lands on.
    http.get(`${API}/artifacts`, () => HttpResponse.json(fx.page([]))),
  );
  return seen;
}

test('canDelete is for the publisher and admins', () => {
  const me = (o: Partial<Me>) => fx.me({ id: 'usr_2', role: 'member', ...o });
  expect(canDelete(me({}), { created_by: 'usr_2' })).toBe(true);
  expect(canDelete(me({}), { created_by: 'usr_1' })).toBe(false);
  expect(canDelete(me({}), { created_by: null })).toBe(false);
  expect(canDelete(me({ role: 'admin' }), { created_by: 'usr_1' })).toBe(true);
  expect(canDelete(me({ role: 'admin' }), { created_by: null })).toBe(true);
});

test('raw and review links', async () => {
  serveReview();
  const { user, router } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  const writeText = stubClipboard();

  // Following the latest version, the links follow it too.
  let menu = await openMenu(user);
  const raw = within(menu).getByRole('menuitem', { name: 'Open raw page' });
  expect(raw).toHaveAttribute('href', '/a/art_1/raw');
  expect(raw).toHaveAttribute('target', '_blank');
  expect(raw.getAttribute('rel')).toContain('noopener');
  expect(raw.getAttribute('rel')).toContain('noreferrer');
  await user.click(within(menu).getByRole('menuitem', { name: 'Copy review link' }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('http://localhost:3000/a/art_1'));
  expect(await screen.findByText('Link copied', {}, TIMEOUT)).toBeInTheDocument();

  // A chosen version has its own links.
  await act(() => router.navigate('/a/art_1/v/2'));
  await screen.findByTitle('Pricing, v2', {}, TIMEOUT);
  menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: 'Open raw page' })).toHaveAttribute(
    'href',
    '/a/art_1/v/2/raw',
  );
  await user.click(within(menu).getByRole('menuitem', { name: 'Copy review link' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith('http://localhost:3000/a/art_1/v/2'),
  );
  menu = await openMenu(user);
  await user.click(within(menu).getByRole('menuitem', { name: 'Copy raw link' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith('http://localhost:3000/a/art_1/v/2/raw'),
  );
});

test('a link that cannot be copied says so', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  stubClipboard(() => Promise.reject(new Error('denied')));

  const menu = await openMenu(user);
  await user.click(within(menu).getByRole('menuitem', { name: 'Copy raw link' }));
  expect(await screen.findByText(t('web.comments.copyFailed'), {}, TIMEOUT)).toBeInTheDocument();
  expect(screen.queryByText('Link copied')).not.toBeInTheDocument();
});

test('the menu lists its items in order, with Full screen and the shortcuts working', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1/v/1', { me: reviewer });
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);
  await versionsRead(user, 1);

  const menu = await openMenu(user);
  expect(within(menu).getAllByRole('menuitem').map(labelOf)).toEqual([
    'Open raw page',
    'Copy review link',
    'Copy raw link',
    'Full screen',
    'Keyboard shortcuts',
    'Restore v1 as the current version',
    'Delete v1…',
    'Delete artifact…',
  ]);
  // One separator sets the version actions apart from the rest.
  expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  expect(within(menu).getByRole('menuitem', { name: 'Delete artifact…' }).className).toContain(
    'text-danger',
  );

  await user.click(within(menu).getByRole('menuitem', { name: 'Keyboard shortcuts' }));
  expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' }, TIMEOUT)).toBeVisible();
});

test('phones get Compare and Share in the menu', async () => {
  setViewport(360);
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);

  const menu = await openMenu(user);
  const labels = within(menu).getAllByRole('menuitem').map(labelOf);
  expect(labels.slice(0, 6)).toEqual([
    'Open raw page',
    'Copy review link',
    'Copy raw link',
    'Compare',
    'Share',
    'Full screen',
  ]);
  expect(within(menu).getByRole('menuitem', { name: 'Compare' })).toHaveAttribute(
    'href',
    '/a/art_1/compare?to=3',
  );
});

test('a member who is not the publisher may delete nothing', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1/v/2', { me: member });
  await screen.findByTitle('Pricing, v2', {}, TIMEOUT);
  await versionsRead(user, 2);
  const menu = await openMenu(user);
  expect(within(menu).queryByRole('menuitem', { name: 'Delete v2…' })).not.toBeInTheDocument();
  expect(
    within(menu).queryByRole('menuitem', { name: 'Delete artifact…' }),
  ).not.toBeInTheDocument();
  // Restoring is open to every member.
  expect(
    within(menu).getByRole('menuitem', { name: 'Restore v2 as the current version' }),
  ).toBeInTheDocument();
});

test('a member who is not the publisher viewing the current version gets no version actions', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: member });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  await versionsRead(user, 3);
  const menu = await openMenu(user);
  expect(within(menu).getAllByRole('menuitem').map(labelOf)).toEqual([
    'Open raw page',
    'Copy review link',
    'Copy raw link',
    'Full screen',
    'Keyboard shortcuts',
  ]);
  // No separator with nothing after it.
  expect(within(menu).queryByRole('separator')).not.toBeInTheDocument();
});

test('the publisher deletes a version or the artifact', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1/v/2', { me: reviewer });
  await screen.findByTitle('Pricing, v2', {}, TIMEOUT);
  await versionsRead(user, 2);
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: 'Delete v2…' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Delete artifact…' })).toBeInTheDocument();
});

test('an admin who did not publish deletes too', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: admin });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  await versionsRead(user, 3);
  const menu = await openMenu(user);
  expect(within(menu).getByRole('menuitem', { name: 'Delete v3…' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Delete artifact…' })).toBeInTheDocument();
  // The current version cannot be restored over itself.
  expect(within(menu).queryByRole('menuitem', { name: /^Restore/ })).not.toBeInTheDocument();
});

test('the only version is deleted with the artifact', async () => {
  serveReview({ versions: [1] });
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);
  await versionsRead(user, 1);
  const menu = await openMenu(user);
  expect(within(menu).queryByRole('menuitem', { name: 'Delete v1…' })).not.toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Delete artifact…' })).toBeInTheDocument();
});

test('deleting a version warns about backups and comments', async () => {
  const s = serveReview();
  serveActions(s);
  const { user, router } = renderRoute('/a/art_1/v/2', { me: reviewer });
  await screen.findByTitle('Pricing, v2', {}, TIMEOUT);
  await versionsRead(user, 2);

  await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Delete v2…' }));
  const dialog = await screen.findByRole('alertdialog', {}, TIMEOUT);
  expect(dialog).toHaveAccessibleName('Delete v2?');
  expect(dialog).toHaveTextContent(t('web.review.deleteVersion.body', { number: 2 }));
  expect(t('web.review.deleteVersion.body', { number: 2 })).toContain(
    'Backups made before now still contain it.',
  );

  // Cancel changes nothing.
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(), TIMEOUT);
  expect(s.requests.some((r) => r.startsWith('DELETE'))).toBe(false);

  await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Delete v2…' }));
  const again = await screen.findByRole('alertdialog', {}, TIMEOUT);
  await user.click(within(again).getByRole('button', { name: 'Delete v2' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'), TIMEOUT);
  expect(s.requests).toContain('DELETE /api/v1/artifacts/art_1/versions/2');
  expect(await screen.findByText('v2 was deleted.', {}, TIMEOUT)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(), TIMEOUT);
  // The review follows what is current now.
  expect(await screen.findByTitle('Pricing, v3', {}, TIMEOUT)).toBeInTheDocument();
});

test('deleting the current version moves on to the next newest straight away', async () => {
  const s = serveReview();
  serveActions(s);
  // The artifact is slow to be read again: the review must wait for it before it navigates.
  server.use(
    http.get(`${API}/artifacts/art_1`, async () => {
      if (s.requests.some((r) => r.startsWith('DELETE'))) await delay(300);
      return HttpResponse.json(s.artifact);
    }),
  );
  const { user, router } = renderRoute('/a/art_1/v/3', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  await versionsRead(user, 3);
  await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Delete v3…' }));
  const dialog = await screen.findByRole('alertdialog', {}, TIMEOUT);
  await user.click(within(dialog).getByRole('button', { name: 'Delete v3' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'), TIMEOUT);
  expect(await screen.findByTitle('Pricing, v2', {}, TIMEOUT)).toBeInTheDocument();
  // It never showed the deleted version as the current one first, which a switch would announce.
  expect(screen.queryByText(t('web.review.live.switched', { number: 2 }))).not.toBeInTheDocument();
});

test('a refused version deletion keeps the dialog open with the server message', async () => {
  const s = serveReview();
  serveActions(s);
  server.use(
    http.delete(`${API}/artifacts/art_1/versions/:n`, () =>
      apiError(403, 'forbidden', "Only an admin or the artifact's publisher can delete it."),
    ),
  );
  const { user, router } = renderRoute('/a/art_1/v/2', { me: reviewer });
  await screen.findByTitle('Pricing, v2', {}, TIMEOUT);
  await versionsRead(user, 2);
  await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Delete v2…' }));
  const dialog = await screen.findByRole('alertdialog', {}, TIMEOUT);
  await user.click(within(dialog).getByRole('button', { name: 'Delete v2' }));

  expect(
    await within(dialog).findByText(
      "Only an admin or the artifact's publisher can delete it.",
      {},
      TIMEOUT,
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/a/art_1/v/2');
  expect(screen.queryByText('v2 was deleted.')).not.toBeInTheDocument();
});

test('deleting the artifact returns to its project', async () => {
  const s = serveReview();
  serveActions(s);
  const { user, router } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);

  await user.click(
    within(await openMenu(user)).getByRole('menuitem', { name: 'Delete artifact…' }),
  );
  const dialog = await screen.findByRole('alertdialog', {}, TIMEOUT);
  expect(dialog).toHaveAccessibleName('Delete “Pricing”?');
  expect(dialog).toHaveTextContent(t('web.review.deleteArtifact.body', { name: 'Pricing' }));
  expect(t('web.review.deleteArtifact.body', { name: 'Pricing' })).toContain(
    'Backups made before now still contain it.',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Delete artifact' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj_2'), TIMEOUT);
  expect(s.requests).toContain('DELETE /api/v1/artifacts/art_1');
  expect(await screen.findByText('“Pricing” was deleted.', {}, TIMEOUT)).toBeInTheDocument();
});

test('a refused artifact deletion shows the server message and stays open', async () => {
  const s = serveReview();
  serveActions(s);
  server.use(
    http.delete(`${API}/artifacts/art_1`, () =>
      apiError(403, 'forbidden', "Only an admin or the artifact's publisher can delete it."),
    ),
  );
  const { user, router } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  await user.click(
    within(await openMenu(user)).getByRole('menuitem', { name: 'Delete artifact…' }),
  );
  const dialog = await screen.findByRole('alertdialog', {}, TIMEOUT);
  await user.click(within(dialog).getByRole('button', { name: 'Delete artifact' }));

  expect(
    await within(dialog).findByText(
      "Only an admin or the artifact's publisher can delete it.",
      {},
      TIMEOUT,
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/a/art_1');
  expect(screen.queryByText('“Pricing” was deleted.')).not.toBeInTheDocument();
});

test('restore makes an old version current', async () => {
  const s = serveReview();
  const seen = serveActions(s);
  // The artifact is slow to be read again: the review must wait for it, not show the old current version meanwhile.
  server.use(
    http.get(`${API}/artifacts/art_1`, async () => {
      if (seen.restore.length > 0) await delay(300);
      return HttpResponse.json(s.artifact);
    }),
  );
  const { user, router } = renderRoute('/a/art_1/v/1', { me: reviewer });
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);

  await user.click(
    within(await openMenu(user)).getByRole('menuitem', {
      name: 'Restore v1 as the current version',
    }),
  );

  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'), TIMEOUT);
  expect(seen.restore).toEqual([{ expected_version_id: 'ver_3' }]);
  expect(s.requests).toContain('POST /api/v1/artifacts/art_1/versions/1/restore');
  expect(await screen.findByText('v1 was restored as v4.', {}, TIMEOUT)).toBeInTheDocument();
  // The review now shows the new version, never the old current one on the way.
  expect(await screen.findByTitle('Pricing, v4', {}, TIMEOUT)).toBeInTheDocument();
  expect(s.previews).toEqual([1, 4]);
});

test('restoring over a newer version shows the server message and stays put', async () => {
  const s = serveReview();
  serveActions(s);
  const conflict =
    'The artifact has a newer version (v4) than the one this publish replaces. Fetch the artifact again and publish on top of v4.';
  server.use(
    http.post(`${API}/artifacts/art_1/versions/:n/restore`, () =>
      apiError(409, 'version_conflict', conflict),
    ),
  );
  const { user, router } = renderRoute('/a/art_1/v/1', { me: reviewer });
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);
  await user.click(
    within(await openMenu(user)).getByRole('menuitem', {
      name: 'Restore v1 as the current version',
    }),
  );

  expect(await screen.findByText(conflict, {}, TIMEOUT)).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/a/art_1/v/1');
  expect(screen.queryByText(/was restored as/)).not.toBeInTheDocument();
});
