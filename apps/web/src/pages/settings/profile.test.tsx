import { screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import { qk } from '../../api/keys.ts';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { serveAccount } from '../../test/settings.ts';

const t = i18n.t;

beforeEach(() => serveSidebar());

const settingsNav = () => screen.getByRole('navigation', { name: 'Settings sections' });

test('/settings opens the profile', async () => {
  serveAccount();
  const { router } = renderRoute('/settings');
  expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/settings/profile');
  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe('Profile · Pinwall'));
  const links = within(settingsNav()).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual(['Profile', 'Security', 'API tokens']);
  expect(within(settingsNav()).getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('the owner saves name and email', async () => {
  const { calls } = serveAccount();
  const { user, queryClient } = renderRoute('/settings/profile');

  const name = await screen.findByRole('textbox', { name: 'Name' });
  expect(name).toHaveValue('Ada Lovelace');
  expect(screen.getByRole('textbox', { name: /^Email/ })).toHaveValue('ada@example.com');
  const save = screen.getByRole('button', { name: 'Save changes' });
  expect(save).toBeDisabled();

  await user.clear(name);
  await user.type(name, 'Ada L.');
  await user.clear(screen.getByRole('textbox', { name: /^Email/ }));
  await user.click(save);

  expect(await screen.findByText(t('web.profile.saved'))).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'PATCH', path: '/me', body: { name: 'Ada L.', email: null } }]);
  expect(queryClient.getQueryData(qk.me)).toMatchObject({ name: 'Ada L.', email: null });
  // Saved: nothing left to save.
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('an empty name or a malformed email is refused before any request', async () => {
  const { calls } = serveAccount();
  const { user } = renderRoute('/settings/profile');

  const name = await screen.findByRole('textbox', { name: 'Name' });
  await user.clear(name);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
  expect(name).toHaveFocus();

  await user.type(name, 'Ada');
  const email = screen.getByRole('textbox', { name: /^Email/ });
  await user.clear(email);
  await user.type(email, 'ada at example');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(
    await screen.findByText(/Enter an email address such as name@example\.com/),
  ).toBeInTheDocument();
  expect(email).toHaveFocus();
  expect(calls).toEqual([]);
});

test("the server's refusal is shown as it wrote it", async () => {
  serveAccount();
  server.use(
    http.patch(`${API}/me`, () => apiError(400, 'validation_error', 'That name is already taken.')),
  );
  const { user } = renderRoute('/settings/profile');

  const name = await screen.findByRole('textbox', { name: 'Name' });
  await user.type(name, ' Jr');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('That name is already taken.');
  // The edit is kept so it can be corrected.
  expect(name).toHaveValue('Ada Lovelace Jr');
});

test('saving shows progress and cannot be sent twice', async () => {
  serveAccount();
  let sent = 0;
  server.use(
    http.patch(`${API}/me`, async () => {
      sent += 1;
      await delay(50);
      return HttpResponse.json(fx.me({ name: 'Ada Lovelace Jr' }));
    }),
  );
  const { user } = renderRoute('/settings/profile');
  await user.type(await screen.findByRole('textbox', { name: 'Name' }), ' Jr');
  const save = screen.getByRole('button', { name: 'Save changes' });
  await user.click(save);
  expect(save).toBeDisabled();
  expect(save).toHaveAttribute('aria-busy', 'true');
  expect(await screen.findByText(t('web.profile.saved'))).toBeInTheDocument();
  expect(sent).toBe(1);
});

test('an SSO user sees read-only details and no Security tab', async () => {
  serveAccount({
    me: {
      kind: 'oidc',
      credentials: null,
      role: 'member',
      name: 'Grace Hopper',
      email: 'grace@acme.example',
    },
  });
  const { router } = renderRoute('/settings/security', {
    config: { oidc: { enabled: true, display_name: 'Acme SSO' } },
  });

  expect(
    await screen.findByText(t('web.profile.managedBy', { idp: 'Acme SSO' })),
  ).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/settings/profile');

  const main = screen.getByRole('main');
  expect(within(main).getByText('Grace Hopper')).toBeInTheDocument();
  expect(within(main).getByText('grace@acme.example')).toBeInTheDocument();
  expect(within(main).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(main).queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();

  expect(within(settingsNav()).queryByRole('link', { name: 'Security' })).not.toBeInTheDocument();
  expect(within(settingsNav()).getByRole('link', { name: 'API tokens' })).toBeInTheDocument();
});

test('an SSO user without an email is told so', async () => {
  serveAccount({ me: { kind: 'oidc', credentials: null, email: null } });
  renderRoute('/settings/profile');
  expect(await screen.findByText('No email address')).toBeInTheDocument();
});
