import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import i18n from '../../i18n.ts';
import { fxAdminUser, fxOwnerRow, fxUsage, serveAdminUsers } from '../../test/admin.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { PERSONAL } from '../../test/spaces.ts';

const t = i18n.t.bind(i18n);
const HOUR = 3_600_000;

type User = ReturnType<typeof renderRoute>['user'];

beforeEach(() => {
  serveSidebar();
  setViewport(1600);
});

const GRACE = 'Grace Hopper';
const APPROVED = { share_links: 'approved' } as const;

/** Grace, as a space that holds something and carries one limit of her own. */
const busyGrace = () =>
  fxAdminUser({
    usage: fxUsage({
      projects: 3,
      artifacts: 12,
      versions: 20,
      bytes: 120_000_000,
      share_links: 2,
      last_published_at: Date.now() - 2 * HOUR,
    }),
    quota_bytes: 1_000_000_000,
  });

/** The row of one person in the users table. */
async function rowOf(name: string): Promise<HTMLElement> {
  const table = within(await screen.findByRole('table', { name: 'Users' }));
  const row = table.getAllByRole('row').find((r) => within(r).queryByText(name) !== null);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** The card of one person on a phone. */
async function cardOf(name: string): Promise<HTMLElement> {
  const list = within(await screen.findByRole('list', { name: 'Users' }));
  const card = list.getAllByRole('listitem').find((c) => within(c).queryByText(name) !== null);
  if (!card) throw new Error(`no card for ${name}`);
  return card;
}

const approvalSwitch = (scope: HTMLElement, name: string) =>
  within(scope).getByRole('switch', { name: t('web.admin.approval.for', { name }) });

/** Opens the "More actions" menu of `name` inside `scope`. */
async function openMenu(user: User, scope: HTMLElement, name: string) {
  await user.click(within(scope).getByRole('button', { name: t('web.admin.more', { name }) }));
  return within(await screen.findByRole('menu'));
}

/** Opens Grace's limits dialog. */
async function openLimits(user: User, name = GRACE) {
  const menu = await openMenu(user, await rowOf(name), name);
  await user.click(menu.getByRole('menuitem', { name: t('web.admin.quota.item') }));
  return within(await screen.findByRole('dialog', { name: t('web.admin.quota.title', { name }) }));
}

/** Picks `option` in the Select called `label` of `scope`. */
async function choose(user: User, scope: ReturnType<typeof within>, label: string, option: string) {
  await user.click(scope.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

const STORAGE = t('web.usage.storage');
const ARTIFACTS = t('web.usage.artifacts');

test('each user shows usage, last publish and a custom-limits badge', async () => {
  serveAdminUsers({
    users: [fxOwnerRow(), busyGrace(), fxAdminUser({ id: 'usr_3', name: 'Alan Turing' })],
  });
  renderRoute('/admin/users');

  const grace = await rowOf(GRACE);
  expect(within(grace).getByText('12 artifacts · 120 MB')).toBeInTheDocument();
  expect(within(grace).getByText('3 projects · 20 versions · 2 links')).toBeInTheDocument();
  expect(within(grace).getByText('Published 2 hours ago')).toBeInTheDocument();
  expect(within(grace).getByText('Custom limits')).toBeInTheDocument();

  // Nothing published, nothing stored, no limits of their own: the same lines, no badge.
  const alan = await rowOf('Alan Turing');
  expect(within(alan).getByText('0 artifacts · 0 bytes')).toBeInTheDocument();
  expect(within(alan).getByText('0 projects · 0 versions · 0 links')).toBeInTheDocument();
  expect(within(alan).getByText('Never published')).toBeInTheDocument();
  expect(within(alan).queryByText('Custom limits')).not.toBeInTheDocument();
  // The usage and sharing columns are headed.
  expect(screen.getByRole('columnheader', { name: 'Usage' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Sharing' })).toBeInTheDocument();
});

test('the singular is used for one project, version and link', async () => {
  serveAdminUsers({
    users: [
      fxAdminUser({
        usage: fxUsage({ projects: 1, artifacts: 1, versions: 1, bytes: 1500, share_links: 1 }),
        quota_artifacts: 0,
      }),
    ],
  });
  renderRoute('/admin/users');

  const grace = await rowOf(GRACE);
  expect(within(grace).getByText('1 artifact · 1.5 kB')).toBeInTheDocument();
  expect(within(grace).getByText('1 project · 1 version · 1 link')).toBeInTheDocument();
  // "No limit" is a limit of their own too.
  expect(within(grace).getByText('Custom limits')).toBeInTheDocument();
});

test('a phone card shows the same usage and offers the same controls', async () => {
  const { calls } = serveAdminUsers({ users: [fxOwnerRow(), busyGrace()] });
  setViewport(360);
  const { user } = renderRoute('/admin/users');

  const grace = await cardOf(GRACE);
  expect(within(grace).getByText('12 artifacts · 120 MB')).toBeInTheDocument();
  expect(within(grace).getByText('3 projects · 20 versions · 2 links')).toBeInTheDocument();
  expect(within(grace).getByText('Published 2 hours ago')).toBeInTheDocument();
  expect(within(grace).getByText('Custom limits')).toBeInTheDocument();

  await user.click(approvalSwitch(grace, GRACE));
  await waitFor(() =>
    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/users/usr_2', body: { share_approved: true } },
    ]),
  );
  const menu = await openMenu(user, await cardOf(GRACE), GRACE);
  expect(menu.getByRole('menuitem', { name: t('web.admin.quota.item') })).toBeInTheDocument();
});

test('approval turns on at once, and asks before it is taken away when links need approval', async () => {
  const { calls } = serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  const { user } = renderRoute('/admin/users', { config: APPROVED });

  expect(approvalSwitch(await rowOf(GRACE), GRACE)).not.toBeChecked();
  await user.click(approvalSwitch(await rowOf(GRACE), GRACE));
  await waitFor(async () => expect(approvalSwitch(await rowOf(GRACE), GRACE)).toBeChecked());
  expect(calls).toEqual([
    { method: 'PATCH', path: '/admin/users/usr_2', body: { share_approved: true } },
  ]);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

  // Taking it away revokes every link, so it asks first; Cancel leaves everything as it was.
  await user.click(approvalSwitch(await rowOf(GRACE), GRACE));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText(t('web.admin.approval.removeTitle', { name: GRACE }))).toBeVisible();
  expect(dialog.getByText(t('web.admin.approval.removeBody', { name: GRACE }))).toBeVisible();
  expect(calls).toHaveLength(1);
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(calls).toHaveLength(1);
  expect(approvalSwitch(await rowOf(GRACE), GRACE)).toBeChecked();

  await user.click(approvalSwitch(await rowOf(GRACE), GRACE));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: t('web.admin.approval.removeConfirm'),
    }),
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual({
    method: 'PATCH',
    path: '/admin/users/usr_2',
    body: { share_approved: false },
  });
  await waitFor(async () => expect(approvalSwitch(await rowOf(GRACE), GRACE)).not.toBeChecked());
  // Approval is in force, so there is no warning that it is not.
  expect(screen.queryByText(t('web.admin.approval.inactive'))).not.toBeInTheDocument();
});

test('without approval in force, turning it off sends at once and the page says it has no effect yet', async () => {
  const { calls } = serveAdminUsers({
    users: [fxOwnerRow(), fxAdminUser({ share_approved: true })],
  });
  const { user } = renderRoute('/admin/users');

  expect(await screen.findByText(t('web.admin.approval.inactive'))).toBeInTheDocument();
  await user.click(approvalSwitch(await rowOf(GRACE), GRACE));
  await waitFor(() =>
    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/users/usr_2', body: { share_approved: false } },
    ]),
  );
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('admins may always expose content', async () => {
  const { calls } = serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  const { user } = renderRoute('/admin/users', { config: APPROVED });

  const owner = approvalSwitch(await rowOf('Ada Lovelace'), 'Ada Lovelace');
  expect(owner).toBeChecked();
  expect(owner).toBeDisabled();
  expect(owner).toHaveAccessibleDescription(t('web.admin.approval.admin'));
  await user.click(owner);
  expect(calls).toEqual([]);

  // A member the identity provider made an admin is one too.
  expect(approvalSwitch(await rowOf(GRACE), GRACE)).toBeEnabled();
});

test('an override that makes someone an admin locks their switch on', async () => {
  serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser({ role_override: 'admin' })] });
  renderRoute('/admin/users');

  const grace = approvalSwitch(await rowOf(GRACE), GRACE);
  expect(grace).toBeChecked();
  expect(grace).toBeDisabled();
});

test('limits: instance, none or custom', async () => {
  const { calls } = serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  const { user } = renderRoute('/admin/users');

  let dialog = await openLimits(user);
  // Both start at the instance's limit.
  expect(dialog.getByRole('combobox', { name: STORAGE })).toHaveTextContent('Instance limit');
  expect(dialog.getByRole('combobox', { name: ARTIFACTS })).toHaveTextContent('Instance limit');
  expect(dialog.queryByRole('textbox')).not.toBeInTheDocument();

  await choose(user, dialog, STORAGE, 'Custom');
  await user.type(dialog.getByRole('textbox', { name: t('web.admin.quota.storageAmount') }), '2');
  await choose(user, dialog, t('web.admin.quota.unit'), 'GB');
  await choose(user, dialog, ARTIFACTS, 'No limit');
  await user.click(dialog.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toEqual({
    method: 'PATCH',
    path: '/admin/users/usr_2',
    body: { quota_bytes: 2_000_000_000, quota_artifacts: 0 },
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(within(await rowOf(GRACE)).getByText('Custom limits')).toBeInTheDocument();

  // What was saved is what the dialog shows when it opens again; both back to the instance's.
  dialog = await openLimits(user);
  expect(dialog.getByRole('combobox', { name: STORAGE })).toHaveTextContent('Custom');
  expect(dialog.getByRole('textbox', { name: t('web.admin.quota.storageAmount') })).toHaveValue(
    '2',
  );
  expect(dialog.getByRole('combobox', { name: t('web.admin.quota.unit') })).toHaveTextContent('GB');
  expect(dialog.getByRole('combobox', { name: ARTIFACTS })).toHaveTextContent('No limit');
  await choose(user, dialog, STORAGE, 'Instance limit');
  await choose(user, dialog, ARTIFACTS, 'Instance limit');
  await user.click(dialog.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]?.body).toEqual({ quota_bytes: null, quota_artifacts: null });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(within(await rowOf(GRACE)).queryByText('Custom limits')).not.toBeInTheDocument();
});

test('a custom storage limit in megabytes, and a stored value is shown in the largest whole unit', async () => {
  const { calls } = serveAdminUsers({
    users: [fxAdminUser({ quota_bytes: 1_500_000_000, quota_artifacts: 40 })],
  });
  const { user } = renderRoute('/admin/users');

  const dialog = await openLimits(user);
  // 1.5 GB is not a whole number of GB, so it reads as 1500 MB.
  expect(dialog.getByRole('textbox', { name: t('web.admin.quota.storageAmount') })).toHaveValue(
    '1500',
  );
  expect(dialog.getByRole('combobox', { name: t('web.admin.quota.unit') })).toHaveTextContent('MB');
  expect(dialog.getByRole('textbox', { name: t('web.admin.quota.artifactsAmount') })).toHaveValue(
    '40',
  );

  const amount = dialog.getByRole('textbox', { name: t('web.admin.quota.storageAmount') });
  await user.clear(amount);
  await user.type(amount, '250');
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toEqual({ quota_bytes: 250_000_000, quota_artifacts: 40 });
});

test('a custom limit must be a whole number of at least 1', async () => {
  const { calls } = serveAdminUsers({ users: [fxAdminUser()] });
  const { user } = renderRoute('/admin/users');

  const dialog = await openLimits(user);
  await choose(user, dialog, ARTIFACTS, 'Custom');
  const amount = dialog.getByRole('textbox', { name: t('web.admin.quota.artifactsAmount') });
  for (const text of ['', '1.5', '0', 'ten', '-3']) {
    await user.clear(amount);
    if (text) await user.type(amount, text);
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText(t('web.admin.quota.wholeNumber')), text).toBeInTheDocument();
    expect(amount).toBeInvalid();
    expect(calls, text).toEqual([]);
  }

  // Fixing it sends the request and drops the message.
  await user.clear(amount);
  await user.type(amount, '3');
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toEqual({ quota_bytes: null, quota_artifacts: 3 });
});

test('a stored value that is not a whole number of megabytes is kept as it is', async () => {
  const { calls } = serveAdminUsers({
    users: [fxAdminUser({ quota_bytes: 500_000, quota_artifacts: null })],
  });
  const { user } = renderRoute('/admin/users');

  // Only the artifacts limit changes; the odd storage limit must not be rounded or refused.
  const dialog = await openLimits(user);
  await choose(user, dialog, ARTIFACTS, 'No limit');
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toEqual({ quota_bytes: 500_000, quota_artifacts: 0 });
});

test('the limits of an admin say that admins have none', async () => {
  serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  const { user } = renderRoute('/admin/users');

  const admin = await openLimits(user, 'Ada Lovelace');
  expect(admin.getByText(t('web.admin.quota.adminExempt', { name: 'Ada Lovelace' }))).toBeVisible();
  await user.click(admin.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  const member = await openLimits(user);
  expect(member.queryByText(/Admins have no limits/)).not.toBeInTheDocument();
});

test('a refused limit shows the same words and keeps the dialog open', async () => {
  serveAdminUsers({ users: [fxAdminUser()] });
  server.use(
    http.patch(`${API}/admin/users/usr_2`, () =>
      apiError(400, 'bad_request', 'Send a whole number of at least 0.'),
    ),
  );
  const { user } = renderRoute('/admin/users');

  const dialog = await openLimits(user);
  await choose(user, dialog, ARTIFACTS, 'No limit');
  await user.click(dialog.getByRole('button', { name: 'Save' }));
  expect(await dialog.findByText('Send a whole number of at least 0.')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('Delete all content is not offered in team mode', async () => {
  // In team mode the route does not exist either, so the menu has only the limits.
  const { calls } = serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  const { user } = renderRoute('/admin/users');

  const menu = await openMenu(user, await rowOf(GRACE), GRACE);
  expect(menu.getByRole('menuitem', { name: t('web.admin.quota.item') })).toBeInTheDocument();
  expect(menu.queryByRole('menuitem', { name: t('web.admin.purge.item') })).toBeNull();
  expect(calls).toEqual([]);
});

test("Delete all content is personal-only and needs the person's email", async () => {
  const { calls, requests } = serveAdminUsers({
    users: [fxOwnerRow(), busyGrace()],
  });
  const { user } = renderRoute('/admin/users', { config: PERSONAL });

  const menu = await openMenu(user, await rowOf(GRACE), GRACE);
  await user.click(menu.getByRole('menuitem', { name: t('web.admin.purge.item') }));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(dialog.getByText(t('web.admin.purge.title', { name: GRACE }))).toBeVisible();
  expect(dialog.getByText(t('web.admin.purge.body', { name: GRACE }))).toBeVisible();

  const confirm = dialog.getByRole('button', { name: t('web.purge.button') });
  const field = dialog.getByRole('textbox', {
    name: t('web.purge.type', { value: 'grace@example.com' }),
  });
  expect(confirm).toBeDisabled();
  await user.type(field, 'grace@example.org');
  expect(confirm).toBeDisabled();
  await user.clear(field);
  // Case and surrounding spaces do not matter, and the trimmed text is what is sent.
  await user.type(field, ' GRACE@example.com');
  expect(confirm).toBeEnabled();
  expect(requests).toHaveLength(1);
  await user.click(confirm);

  expect(
    await screen.findByText('Deleted 1 project and 2 artifacts of Grace Hopper.'),
  ).toBeVisible();
  expect(calls).toEqual([
    {
      method: 'POST',
      path: '/admin/users/usr_2/purge',
      body: { confirm_email: 'GRACE@example.com' },
    },
  ]);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  // The list was loaded again, and shows the emptied space.
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(await within(await rowOf(GRACE)).findByText('0 artifacts · 0 bytes')).toBeInTheDocument();
});

test('a person with no email is confirmed by their id', async () => {
  const { calls } = serveAdminUsers({
    users: [fxOwnerRow(), fxAdminUser({ id: 'usr_5', name: 'No Mail', email: null })],
  });
  const { user } = renderRoute('/admin/users', { config: PERSONAL });

  const menu = await openMenu(user, await rowOf('No Mail'), 'No Mail');
  await user.click(menu.getByRole('menuitem', { name: t('web.admin.purge.item') }));
  const dialog = within(await screen.findByRole('alertdialog'));
  await user.type(
    dialog.getByRole('textbox', { name: t('web.purge.type', { value: 'usr_5' }) }),
    'usr_5',
  );
  await user.click(dialog.getByRole('button', { name: t('web.purge.button') }));

  expect(await screen.findByText(/Deleted 1 project and 2 artifacts of No Mail\./)).toBeVisible();
  expect(calls).toEqual([
    { method: 'POST', path: '/admin/users/usr_5/purge', body: { confirm_email: 'usr_5' } },
  ]);
});

test('a refused purge keeps the dialog open and says why', async () => {
  serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  server.use(
    http.post(`${API}/admin/users/usr_2/purge`, () =>
      apiError(
        409,
        'conflict',
        'New artifacts kept arriving while this space was being deleted. Try again.',
      ),
    ),
  );
  const { user } = renderRoute('/admin/users', { config: PERSONAL });

  const menu = await openMenu(user, await rowOf(GRACE), GRACE);
  await user.click(menu.getByRole('menuitem', { name: t('web.admin.purge.item') }));
  const dialog = within(await screen.findByRole('alertdialog'));
  await user.type(
    dialog.getByRole('textbox', { name: t('web.purge.type', { value: 'grace@example.com' }) }),
    'grace@example.com',
  );
  await user.click(dialog.getByRole('button', { name: t('web.purge.button') }));

  expect(
    await dialog.findByText(
      'New artifacts kept arriving while this space was being deleted. Try again.',
    ),
  ).toBeInTheDocument();
});

test('there is no transfer in the app', async () => {
  serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  const { user } = renderRoute('/admin/users', { config: PERSONAL });
  const transfer = /transfer|move/i;

  for (const name of ['Ada Lovelace', GRACE]) {
    const menu = await openMenu(user, await rowOf(name), name);
    expect(menu.queryAllByRole('menuitem', { name: transfer })).toEqual([]);
    expect(menu.getAllByRole('menuitem').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  }
  expect(screen.queryAllByRole('button', { name: transfer })).toEqual([]);
  expect(screen.queryAllByRole('link', { name: transfer })).toEqual([]);
  expect(document.body).not.toHaveTextContent(transfer);
});

test("a refused change shows the server's words and keeps the old value", async () => {
  serveAdminUsers({ users: [fxOwnerRow(), fxAdminUser()] });
  server.use(
    http.patch(`${API}/admin/users/usr_2`, () =>
      apiError(
        400,
        'bad_request',
        'Send at least one of share_approved, quota_bytes and quota_artifacts',
      ),
    ),
  );
  const { user } = renderRoute('/admin/users');

  await user.click(approvalSwitch(await rowOf(GRACE), GRACE));
  expect(
    await screen.findByText('Send at least one of share_approved, quota_bytes and quota_artifacts'),
  ).toBeInTheDocument();
  await waitFor(async () => expect(approvalSwitch(await rowOf(GRACE), GRACE)).not.toBeChecked());
});
