import { act, screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import { qk } from '../../api/keys.ts';
import i18n from '../../i18n.ts';
import {
  fxAdminUser,
  fxOwnerRow,
  OWN_ROLE_MESSAGE,
  OWNER_ROLE_MESSAGE,
  serveAdminUsers,
} from '../../test/admin.ts';
import { fx } from '../../test/fixtures.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';

const t = i18n.t;
const HOUR = 3_600_000;

/** A window wide enough that the content area leaves room for the table. */
const WIDE = 1500;

beforeEach(() => {
  serveSidebar();
  setViewport(WIDE);
});

/** The users table, once it has loaded. */
const usersTable = () => screen.findByRole('table', { name: 'Users' });

/** The row of one person, found by their name. */
async function rowOf(name: string): Promise<HTMLElement> {
  const table = within(await usersTable());
  const row = table.getAllByRole('row').find((r) => within(r).queryByText(name) !== null);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** The cell with the effective-role badge (the first cell: the person is the row header). */
const roleCell = (row: HTMLElement) => within(within(row).getAllByRole('cell')[0] as HTMLElement);

/** The badge element holding `text` inside `scope`. */
const badgeIn = (scope: ReturnType<typeof within>, text: string) =>
  scope.getByText(text).parentElement;

/** Picks `option` in the role Select of `row`. */
async function chooseRole(
  user: ReturnType<typeof renderRoute>['user'],
  row: HTMLElement,
  option: string,
) {
  await user.click(within(row).getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: option }));
}

const people = () => [
  fxOwnerRow({ last_seen_at: Date.now() }),
  fxAdminUser({ last_seen_at: Date.now() - 2 * HOUR }),
  fxAdminUser({
    id: 'usr_3',
    name: 'Alan Turing',
    email: 'alan@example.com',
    email_verified: false,
    idp_role: 'admin',
    disabled_at: Date.now() - 1000,
    disabled_reason: 'idp_removed',
  }),
  fxAdminUser({ id: 'usr_4', name: 'Katherine Johnson', role_override: 'blocked' }),
];

test('users show effective role, kind, last seen and removal status', async () => {
  serveAdminUsers({ users: people() });
  renderRoute('/admin');

  const owner = await rowOf('Ada Lovelace');
  expect(within(owner).getByText('Owner')).toBeInTheDocument();
  expect(within(owner).getByText('ada@example.com')).toBeInTheDocument();
  expect(within(owner).getByText('Email verified')).toBeInTheDocument();
  expect(roleCell(owner).getByText('Admin')).toBeInTheDocument();
  // The owner signs in with a password or passkey, not an identity provider.
  expect(roleCell(owner).queryByText(/Identity provider/)).not.toBeInTheDocument();

  const grace = await rowOf('Grace Hopper');
  expect(within(grace).getByText('SSO')).toBeInTheDocument();
  expect(roleCell(grace).getByText('Member')).toBeInTheDocument();
  expect(within(grace).getByText('2 hours ago')).toBeInTheDocument();
  // Under the role, what the identity provider gave; the Select is the override that would replace it.
  expect(roleCell(grace).getByText('Identity provider: Member')).toBeInTheDocument();
  expect(within(grace).getByRole('combobox')).toHaveTextContent('Use identity provider role');
  expect(within(grace).queryByText('Removed from identity provider')).not.toBeInTheDocument();

  // A removed person is flagged; their unverified email carries no marker.
  const alan = await rowOf('Alan Turing');
  expect(within(alan).getByText('Removed from identity provider')).toBeInTheDocument();
  expect(within(alan).queryByText('Email verified')).not.toBeInTheDocument();
  expect(within(alan).getByText('Never')).toBeInTheDocument();
  expect(roleCell(alan).getByText('Identity provider: Admin')).toBeInTheDocument();

  // Blocked is shown as a danger badge, and the override is the one chosen.
  const katherine = await rowOf('Katherine Johnson');
  expect(badgeIn(roleCell(katherine), 'Blocked')).toHaveClass('bg-danger-soft');
  expect(roleCell(katherine).getByText('Identity provider: Member')).toBeInTheDocument();
  expect(within(katherine).getByRole('combobox')).toHaveTextContent('Blocked');
});

test('the page opens the user list and names itself', async () => {
  serveAdminUsers({ users: people() });
  const { router } = renderRoute('/admin');
  await usersTable();

  expect(router.state.location.pathname).toBe('/admin/users');
  expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe('Users · Pinwall'));
  const nav = screen.getByRole('navigation', { name: 'Admin sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['Users', 'Configuration']);
  expect(within(nav).getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
});

test('the role override is saved, including back to the IdP role', async () => {
  const { calls } = serveAdminUsers({ users: people() });
  const { user } = renderRoute('/admin/users');
  const grace = await rowOf('Grace Hopper');

  await chooseRole(user, grace, 'Blocked');
  expect(calls).toEqual([
    { method: 'PUT', path: '/admin/users/usr_2/role', body: { role_override: 'blocked' } },
  ]);
  // The row now shows what the server answered.
  await waitFor(async () => {
    const row = await rowOf('Grace Hopper');
    expect(within(row).getByRole('combobox')).toHaveTextContent('Blocked');
    expect(badgeIn(roleCell(row), 'Blocked')).toHaveClass('bg-danger-soft');
  });
  expect(await screen.findByText("Grace Hopper's role was updated.")).toBeInTheDocument();

  await chooseRole(user, await rowOf('Grace Hopper'), 'Use identity provider role');
  expect(calls[1]).toEqual({
    method: 'PUT',
    path: '/admin/users/usr_2/role',
    body: { role_override: null },
  });
  await waitFor(async () => {
    const row = await rowOf('Grace Hopper');
    expect(within(row).getByRole('combobox')).toHaveTextContent('Use identity provider role');
    expect(roleCell(row).getByText('Member')).toBeInTheDocument();
  });

  // The other options are the other roles.
  await chooseRole(user, await rowOf('Grace Hopper'), 'Admin');
  expect(calls[2]?.body).toEqual({ role_override: 'admin' });
  await waitFor(async () => {
    expect(within(await rowOf('Grace Hopper')).getByRole('combobox')).toHaveTextContent('Admin');
  });
});

test("the server's refusal of a role change is shown verbatim and the row keeps its role", async () => {
  serveAdminUsers({ users: people() });
  server.use(
    http.put(`${API}/admin/users/usr_2/role`, () =>
      apiError(403, 'forbidden', 'Only an admin can change roles.'),
    ),
  );
  const { user } = renderRoute('/admin/users');
  const grace = await rowOf('Grace Hopper');

  await chooseRole(user, grace, 'Blocked');
  expect(await screen.findByText('Only an admin can change roles.')).toBeInTheDocument();
  const after = await rowOf('Grace Hopper');
  expect(within(after).getByRole('combobox')).toHaveTextContent('Use identity provider role');
  expect(roleCell(after).getByText('Member')).toBeInTheDocument();
});

test('your own role cannot be changed', async () => {
  const { calls } = serveAdminUsers({ users: people() });
  renderRoute('/admin/users');

  const own = await rowOf('Ada Lovelace');
  expect(within(own).getByRole('combobox')).toBeDisabled();
  expect(within(own).getByText('You')).toBeInTheDocument();

  // The reason shows on focus; the disabled control itself cannot take focus.
  const lock = within(own).getByRole('group', { name: 'Role for Ada Lovelace' });
  act(() => lock.focus());
  expect(await screen.findByRole('tooltip')).toHaveTextContent(t('auth.ownRole'));
  expect(t('auth.ownRole')).toBe(OWN_ROLE_MESSAGE);

  // Others stay editable.
  expect(within(await rowOf('Grace Hopper')).getByRole('combobox')).toBeEnabled();
  expect(calls).toEqual([]);
});

test("the owner's role is locked for every admin, with its reason", async () => {
  const me = fx.me({ id: 'usr_9', kind: 'oidc', name: 'Hedy Lamarr', role: 'admin' });
  serveAdminUsers({
    actorId: 'usr_9',
    users: [fxOwnerRow(), fxAdminUser({ id: 'usr_9', name: 'Hedy Lamarr', idp_role: 'admin' })],
  });
  renderRoute('/admin/users', { me });

  const owner = await rowOf('Ada Lovelace');
  expect(within(owner).getByRole('combobox')).toBeDisabled();
  act(() => within(owner).getByRole('group', { name: 'Role for Ada Lovelace' }).focus());
  expect(await screen.findByRole('tooltip')).toHaveTextContent(t('auth.ownerRole'));
  expect(t('auth.ownerRole')).toBe(OWNER_ROLE_MESSAGE);
});

test('Revoke now asks, then reports what ended', async () => {
  const { calls } = serveAdminUsers({ users: people() });
  const { user } = renderRoute('/admin/users');
  const grace = await rowOf('Grace Hopper');

  await user.click(within(grace).getByRole('button', { name: 'Revoke now for Grace Hopper' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText("Revoke Grace Hopper's access now?")).toBeInTheDocument();
  expect(
    dialog.getByText(
      'Grace Hopper is signed out of every browser at once, and their API tokens and agent connections stop working. They can sign in again if they still have access.',
    ),
  ).toBeInTheDocument();
  // Revoking also ends what the person shared, which no later sign-in brings back.
  expect(
    dialog.getByText('Every share link made from this account is revoked too, for good.'),
  ).toBeInTheDocument();

  // Cancel changes nothing.
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(calls).toEqual([]);

  await user.click(within(grace).getByRole('button', { name: 'Revoke now for Grace Hopper' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke now' }),
  );
  expect(
    await screen.findByText('Revoked 2 sessions, 1 API token and 1 agent connection.'),
  ).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'POST', path: '/admin/users/usr_2/revoke', body: undefined }]);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
});

test('the Revoke now summary uses the singular for one and the plural for the rest', async () => {
  serveAdminUsers({
    users: people(),
    revoked: { sessions: 1, api_tokens: 2, oauth_grants: 0 },
  });
  const { user } = renderRoute('/admin/users');
  const grace = await rowOf('Grace Hopper');

  await user.click(within(grace).getByRole('button', { name: 'Revoke now for Grace Hopper' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke now' }),
  );
  expect(
    await screen.findByText('Revoked 1 session, 2 API tokens and 0 agent connections.'),
  ).toBeInTheDocument();
});

test('a failed Revoke now keeps the dialog open and says why', async () => {
  serveAdminUsers({ users: people() });
  server.use(
    http.post(`${API}/admin/users/usr_2/revoke`, () =>
      apiError(404, 'not_found', 'This user does not exist.'),
    ),
  );
  const { user } = renderRoute('/admin/users');
  await user.click(
    within(await rowOf('Grace Hopper')).getByRole('button', {
      name: 'Revoke now for Grace Hopper',
    }),
  );
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke now' }),
  );
  expect(
    await within(await screen.findByRole('alertdialog')).findByText('This user does not exist.'),
  ).toBeInTheDocument();
});

test('revoking yourself signs you out', async () => {
  const { calls } = serveAdminUsers({ users: people() });
  const { user, router, queryClient } = renderRoute('/admin/users');
  // Something cached for this person, which must not outlive the session.
  queryClient.setQueryData(['artifacts', 'recent'], fx.page([fx.artifact()]));

  const own = await rowOf('Ada Lovelace');
  await user.click(within(own).getByRole('button', { name: 'Revoke now for Ada Lovelace' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText('Revoke your own access now?')).toBeInTheDocument();
  expect(
    dialog.getByText('You will be signed out everywhere, including here.'),
  ).toBeInTheDocument();
  expect(
    dialog.getByText('Every share link made from this account is revoked too, for good.'),
  ).toBeInTheDocument();
  expect(dialog.queryByText(/stop working/)).not.toBeInTheDocument();

  // From here on the server no longer knows this browser.
  server.use(http.get(`${API}/me`, () => apiError(401, 'unauthorized', 'Sign in to continue.')));
  await user.click(dialog.getByRole('button', { name: 'Revoke now' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(calls).toEqual([
    { method: 'POST', path: '/admin/users/usr_0000000000000000000a/revoke', body: undefined },
  ]);
  expect(queryClient.getQueryData(qk.me)).toBeNull();
  expect(queryClient.getQueryData(['artifacts', 'recent'])).toBeUndefined();
  expect(queryClient.getQueryData(qk.adminUsers)).toBeUndefined();
});

test('the user list pages', async () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    fxAdminUser({
      id: `usr_${10 + i}`,
      name: `Person ${i + 1}`,
      email: `p${i + 1}@example.com`,
      created_at: Date.UTC(2026, 10, 1 + i),
    }),
  );
  const { requests } = serveAdminUsers({ users: many, pageSize: 3 });
  const { user } = renderRoute('/admin/users');

  await rowOf('Person 3');
  expect(requests).toEqual(['?limit=50']);
  expect(screen.queryByText('Person 4')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await rowOf('Person 5');
  expect(requests[1]).toBe('?cursor=3&limit=50');
  expect(screen.getByText('Person 1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('a failed later page keeps the users and says why', async () => {
  const many = Array.from({ length: 4 }, (_, i) =>
    fxAdminUser({ id: `usr_${10 + i}`, name: `Person ${i + 1}`, email: null }),
  );
  serveAdminUsers({ users: many, pageSize: 2 });
  server.use(
    http.get(`${API}/admin/users`, ({ request }) => {
      if (new URL(request.url).searchParams.has('cursor')) {
        return apiError(500, 'internal', 'The user list is unavailable.');
      }
      return HttpResponse.json(fx.page(many.slice(0, 2), '2'));
    }),
  );
  const { user } = renderRoute('/admin/users');
  await rowOf('Person 2');

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('The user list is unavailable.')).toBeInTheDocument();
  expect(screen.getByText('Person 1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
});

test('non-admins see the admin-only message and nothing is fetched', async () => {
  let fetched = 0;
  server.use(
    http.get(`${API}/admin/users`, () => {
      fetched += 1;
      return HttpResponse.json(fx.page([]));
    }),
    http.get(`${API}/admin/config`, () => {
      fetched += 1;
      return apiError(403, 'forbidden', 'Only admins can do this.');
    }),
  );
  const { router } = renderRoute('/admin/users', { me: fx.me({ role: 'member' }) });

  expect(await screen.findByText(t('auth.adminOnly'))).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/admin/users');
  await act(() => delay(30));
  expect(fetched).toBe(0);
});

test('the users stack as cards with the same controls on a phone', async () => {
  const { calls } = serveAdminUsers({ users: people() });
  setViewport(360);
  const { user } = renderRoute('/admin/users');

  const list = await screen.findByRole('list', { name: 'Users' });
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  const cards = within(list).getAllByRole('listitem');
  expect(cards).toHaveLength(4);

  const grace = cards.find((c) => within(c).queryByText('Grace Hopper')) as HTMLElement;
  expect(within(grace).getByText('SSO')).toBeInTheDocument();
  expect(within(grace).getByText('2 hours ago')).toBeInTheDocument();
  expect(within(grace).getByText('Identity provider: Member')).toBeInTheDocument();
  await chooseRole(user, grace, 'Admin');
  expect(calls[0]).toEqual({
    method: 'PUT',
    path: '/admin/users/usr_2/role',
    body: { role_override: 'admin' },
  });

  // Where a tooltip cannot show on touch, the reason for a locked role is printed.
  const own = cards.find((c) => within(c).queryByText('Ada Lovelace')) as HTMLElement;
  expect(within(own).getByRole('combobox')).toBeDisabled();
  expect(within(own).getByText(t('auth.ownRole'))).toBeInTheDocument();
});

test('the table needs 1100 px of content, so a narrower content area gets cards', async () => {
  // The open sidebar (264 px), its border, the page gutters (2 x 32 px) and a
  // scrollbar leave about 1100 px of content from 1450 px of window.
  serveAdminUsers({ users: people() });
  setViewport(1449);
  renderRoute('/admin/users');

  expect(await screen.findByRole('list', { name: 'Users' })).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();

  setViewport(1450);
  expect(await usersTable()).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Users' })).not.toBeInTheDocument();
});

test('a tablet window shows cards, not a table that needs to scroll sideways', async () => {
  serveAdminUsers({ users: people() });
  setViewport(768);
  renderRoute('/admin/users');

  expect(await screen.findByRole('list', { name: 'Users' })).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('admin lists have loading and error states', async () => {
  let fail = true;
  server.use(
    http.get(`${API}/admin/users`, async () => {
      await delay(40);
      return fail
        ? apiError(500, 'internal', 'The user list is unavailable.')
        : HttpResponse.json(fx.page(people()));
    }),
  );
  const { user } = renderRoute('/admin/users');

  expect(await screen.findByRole('status', { name: 'Loading users' })).toBeInTheDocument();
  expect(await screen.findByText('The user list is unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Loading users' })).not.toBeInTheDocument();

  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await rowOf('Grace Hopper')).toBeInTheDocument();
});

test('an empty user list says so', async () => {
  serveAdminUsers({ users: [] });
  renderRoute('/admin/users');
  expect(await screen.findByText('No users yet')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
