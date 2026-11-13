import { screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import i18n from '../../i18n.ts';
import { fxAdminPerson, fxAdminShareLink, serveModeration } from '../../test/admin.ts';
import { fx } from '../../test/fixtures.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';

const t = i18n.t.bind(i18n);
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(() => {
  serveSidebar();
  setViewport(1600);
});

const CAROL = fxAdminPerson({ id: 'usr_c', name: 'Carol Example', email: 'carol@example.test' });

/** Bob's link to Pricing, with a password, last opened two hours ago. */
const pricing = () =>
  fxAdminShareLink({
    id: 'shr_1',
    has_password: true,
    last_used_at: Date.now() - 2 * HOUR,
  });

/** Bob's artifact, a link Carol made to v3 of it, with comments, ending in three days. */
const roadmap = () =>
  fxAdminShareLink({
    id: 'shr_2',
    artifact: { id: 'art_2', name: 'Roadmap' },
    created_by: CAROL,
    version: { id: 'ver_3', number: 3 },
    allow_comments: true,
    expires_at: Date.now() + 3 * DAY + HOUR,
  });

/** The row of one artifact in the table. */
async function rowOf(name: string): Promise<HTMLElement> {
  const table = within(await screen.findByRole('table', { name: 'Share links' }));
  const row = table.getAllByRole('row').find((r) => within(r).queryByText(name) !== null);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** The card of one artifact on a narrow screen. */
async function cardOf(name: string): Promise<HTMLElement> {
  const list = within(await screen.findByRole('list', { name: 'Share links' }));
  const card = list.getAllByRole('listitem').find((c) => within(c).queryByText(name) !== null);
  if (!card) throw new Error(`no card for ${name}`);
  return card;
}

test('the share-link list shows metadata and pages', async () => {
  const { requests } = serveModeration({ links: [pricing(), roadmap()], pageSize: 1 });
  const { user } = renderRoute('/admin/share-links');

  const first = await rowOf('Pricing');
  expect(within(first).getByText('Bob Example')).toBeInTheDocument();
  expect(within(first).getByText('bob@example.test')).toBeInTheDocument();
  expect(within(first).getByText('Latest version')).toBeInTheDocument();
  expect(within(first).getByText('Password')).toBeInTheDocument();
  expect(within(first).queryByText('Comments')).not.toBeInTheDocument();
  expect(within(first).getByText('Nov 1, 2026')).toBeInTheDocument();
  // No expiry, and opened two hours ago; the owner made it, so no "made by" line.
  expect(within(first).getByText('Never')).toBeInTheDocument();
  expect(within(first).getByText('2 hours ago')).toBeInTheDocument();
  expect(within(first).queryByText(/Made by/)).not.toBeInTheDocument();
  expect(screen.queryByText('Roadmap')).not.toBeInTheDocument();

  // Metadata only: nothing on the page leads to the artifact, the link or its content.
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    expect(href).not.toContain('/s/');
    expect(href).not.toContain('/a/');
    expect(href).not.toContain('/c/');
  }
  expect(
    screen.getByText(
      'Every share link that still opens, across all people. Pinwall stores only a hash of each link, so links cannot be opened from here; to check a reported address, use Look up a link.',
    ),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  const second = await rowOf('Roadmap');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain('cursor=1');
  expect(within(second).getByText('v3')).toBeInTheDocument();
  expect(within(second).getByText('Comments')).toBeInTheDocument();
  expect(within(second).queryByText('Password')).not.toBeInTheDocument();
  expect(within(second).getByText('in 3 days')).toBeInTheDocument();
  expect(within(second).getByText('Never')).toBeInTheDocument();
  // Carol made it for Bob's artifact.
  expect(within(second).getByText('Bob Example')).toBeInTheDocument();
  expect(within(second).getByText('Made by Carol Example')).toBeInTheDocument();
  // Both pages are on screen, and nothing is left to load.
  expect(within(await rowOf('Pricing')).getByText('Password')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('a link without an owner or a maker still lists', async () => {
  serveModeration({ links: [fxAdminShareLink({ owner: null, created_by: null })] });
  renderRoute('/admin/share-links');
  const row = await rowOf('Pricing');
  expect(within(row).getByText(t('web.admin.person.none'))).toBeInTheDocument();
  expect(t('web.admin.person.none')).toBe('No account');
});

test('a narrow screen lists the same facts on cards, with the same actions', async () => {
  const { calls } = serveModeration({ links: [pricing(), roadmap()] });
  setViewport(360);
  const { user } = renderRoute('/admin/share-links');

  const card = await cardOf('Pricing');
  expect(within(card).getByText('Bob Example')).toBeInTheDocument();
  expect(within(card).getByText('bob@example.test')).toBeInTheDocument();
  expect(within(card).getByText('Latest version')).toBeInTheDocument();
  expect(within(card).getByText('Password')).toBeInTheDocument();
  expect(within(card).getByText('2 hours ago')).toBeInTheDocument();
  expect(within(await cardOf('Roadmap')).getByText('Made by Carol Example')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();

  await user.click(within(card).getByRole('button', { name: 'Revoke the link to Pricing' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke link' }),
  );
  await waitFor(() => expect(screen.queryByText('Pricing')).not.toBeInTheDocument());
  expect(calls).toEqual([{ method: 'DELETE', path: '/admin/share-links/shr_1', body: undefined }]);
  expect(screen.getByText('Roadmap')).toBeInTheDocument();
});

test('revoke asks, then the link leaves the list', async () => {
  const { calls, requests } = serveModeration({ links: [pricing(), roadmap()] });
  const { user } = renderRoute('/admin/share-links');
  const row = await rowOf('Pricing');

  await user.click(within(row).getByRole('button', { name: 'Revoke the link to Pricing' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText('Revoke this link?')).toBeInTheDocument();
  expect(
    dialog.getByText(
      'The link to “Pricing” stops working at once, and so do the pages it opened. The artifact and its other links stay.',
    ),
  ).toBeInTheDocument();

  // Cancel changes nothing.
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(calls).toEqual([]);

  await user.click(within(row).getByRole('button', { name: 'Revoke the link to Pricing' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke link' }),
  );
  await waitFor(() => expect(screen.queryByText('Pricing')).not.toBeInTheDocument());
  expect(calls).toEqual([{ method: 'DELETE', path: '/admin/share-links/shr_1', body: undefined }]);
  expect(await screen.findByText('Revoked the link to “Pricing”.')).toBeInTheDocument();
  // The other link stays, and the list was not loaded again to show this.
  expect(screen.getByText('Roadmap')).toBeInTheDocument();
  expect(requests).toHaveLength(1);
});

test('a refused revoke keeps the link and says why', async () => {
  serveModeration({ links: [pricing()] });
  server.use(
    http.delete(`${API}/admin/share-links/shr_1`, () =>
      apiError(404, 'not_found', 'No such share link.'),
    ),
  );
  const { user } = renderRoute('/admin/share-links');
  const row = await rowOf('Pricing');

  await user.click(within(row).getByRole('button', { name: 'Revoke the link to Pricing' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  await user.click(dialog.getByRole('button', { name: 'Revoke link' }));
  expect(await dialog.findByText('No such share link.')).toBeInTheDocument();
  expect(screen.getByText('Pricing')).toBeInTheDocument();
});

test('delete artifact warns, then refreshes', async () => {
  const sameArtifact = fxAdminShareLink({ id: 'shr_3', has_password: true });
  const { calls, requests } = serveModeration({ links: [pricing(), sameArtifact, roadmap()] });
  const { user } = renderRoute('/admin/share-links');
  const row = (await screen.findAllByText('Pricing'))[0]?.closest('tr');
  if (!row) throw new Error('no row');

  await user.click(within(row).getByRole('button', { name: 'Delete artifact Pricing' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText('Delete “Pricing”?')).toBeInTheDocument();
  expect(
    dialog.getByText(
      'Deletes “Pricing” for its owner too: every version, comment and share link. This cannot be undone.',
    ),
  ).toBeInTheDocument();
  expect(calls).toEqual([]);

  await user.click(dialog.getByRole('button', { name: 'Delete artifact' }));
  // Every link of that artifact is gone after the list loads again; the others stay.
  await waitFor(() => expect(screen.queryByText('Pricing')).not.toBeInTheDocument());
  expect(calls).toEqual([{ method: 'DELETE', path: '/admin/artifacts/art_1', body: undefined }]);
  expect(requests).toHaveLength(2);
  expect(screen.getByText('Roadmap')).toBeInTheDocument();
  expect(await screen.findByText('Deleted “Pricing”.')).toBeInTheDocument();
});

test('list states', async () => {
  // Loading, then failing, then Retry brings the rows.
  let fail = true;
  server.use(
    http.get(`${API}/admin/share-links`, async () => {
      await delay(40);
      return fail
        ? apiError(500, 'internal', 'The list is unavailable.')
        : HttpResponse.json(fx.page([pricing()]));
    }),
  );
  const { user } = renderRoute('/admin/share-links');
  expect(await screen.findByRole('status', { name: 'Loading share links' })).toBeInTheDocument();
  expect(await screen.findByText('The list is unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Loading share links' })).not.toBeInTheDocument();

  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await rowOf('Pricing')).toBeInTheDocument();
});

test('an empty list says so', async () => {
  serveModeration({ links: [] });
  renderRoute('/admin/share-links');
  expect(await screen.findByText('No share link is open right now.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('a failed next page keeps the rows and says why', async () => {
  serveModeration({ links: [pricing(), roadmap()], pageSize: 1 });
  const { user } = renderRoute('/admin/share-links');
  await rowOf('Pricing');

  server.use(
    http.get(`${API}/admin/share-links`, () => apiError(500, 'internal', 'Could not load more.')),
  );
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more.');
  expect(await rowOf('Pricing')).toBeInTheDocument();
});

test('the page names itself and its nav entry is current', async () => {
  serveModeration({ links: [pricing()] });
  renderRoute('/admin/share-links');
  await rowOf('Pricing');
  await waitFor(() => expect(document.title).toBe('Share links · Pinwall'));
  const nav = screen.getByRole('navigation', { name: 'Admin sections' });
  expect(within(nav).getByRole('link', { name: 'Share links' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('names render as text', async () => {
  serveModeration({
    links: [
      fxAdminShareLink({
        artifact: { id: 'art_1', name: '<i>Pricing</i>' },
        owner: fxAdminPerson({ name: '<b>Bob</b>', email: '<u>bob</u>@example.test' }),
      }),
    ],
  });
  renderRoute('/admin/share-links');
  await screen.findByText('<i>Pricing</i>');
  expect(screen.getByText('<b>Bob</b>')).toBeInTheDocument();
  expect(screen.getByText('<u>bob</u>@example.test')).toBeInTheDocument();
  expect(document.querySelector('main i, main b, main u')).toBeNull();
});
