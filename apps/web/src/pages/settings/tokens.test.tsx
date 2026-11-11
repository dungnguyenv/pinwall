import { screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import i18n from '../../i18n.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { fxToken, NEW_TOKEN_SECRET, serveAccount } from '../../test/settings.ts';

const t = i18n.t;
const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeEach(() => serveSidebar());

const tokensCard = () => screen.findByRole('region', { name: 'API tokens' });

/** Opens the create dialog from the card's header button. */
async function openCreate(user: ReturnType<typeof renderRoute>['user']) {
  await user.click(await within(await tokensCard()).findByRole('button', { name: 'Create token' }));
  return within(await screen.findByRole('dialog', { name: 'Create an API token' }));
}

test('the token secret is shown once', async () => {
  const { calls } = serveAccount();
  const { user, queryClient } = renderRoute('/settings/tokens');
  const dialog = await openCreate(user);

  await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'ci');
  expect(dialog.getByRole('combobox', { name: 'Expires' })).toHaveTextContent('90 days');
  await user.click(dialog.getByRole('button', { name: 'Create token' }));

  // The result step: the secret in a copy field, and the warning that it is shown once.
  const result = within(await screen.findByRole('dialog', { name: 'Token created' }));
  expect(result.getByLabelText('Your token')).toHaveValue(NEW_TOKEN_SECRET);
  expect(result.getByText(t('web.tokens.secretOnce'))).toBeInTheDocument();
  expect(t('web.tokens.secretOnce')).toBe(
    'Copy this token now. Pinwall keeps only a hash of it, so you will not see it again.',
  );
  expect(calls).toEqual([
    { method: 'POST', path: '/me/tokens', body: { name: 'ci', expires_in_days: 90 } },
  ]);

  // The secret is held by the dialog alone, never by a cache.
  const cached = JSON.stringify([
    ...queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.state.data),
    ...queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state.data),
  ]);
  expect(cached).not.toContain(NEW_TOKEN_SECRET);

  // A stray Escape or click beside the dialog cannot throw the secret away.
  await user.keyboard('{Escape}');
  await user.click(
    screen.getByRole('dialog', { name: 'Token created' }).parentElement as HTMLElement,
  );
  expect(screen.getByRole('dialog', { name: 'Token created' })).toBeInTheDocument();
  expect(result.getByLabelText('Your token')).toHaveValue(NEW_TOKEN_SECRET);

  await user.click(result.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByText(NEW_TOKEN_SECRET)).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(NEW_TOKEN_SECRET)).not.toBeInTheDocument();

  // The list shows the new token by its prefix only.
  const card = within(await tokensCard());
  expect(await card.findByText('ci')).toBeInTheDocument();
  expect(card.getByText('pw_abcdefgh')).toBeInTheDocument();

  // Opening the dialog again starts blank: no secret, no earlier name.
  const again = await openCreate(user);
  expect(again.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  expect(screen.queryByDisplayValue(NEW_TOKEN_SECRET)).not.toBeInTheDocument();
});

test('a token without expiry sends null', async () => {
  const { calls } = serveAccount();
  const { user } = renderRoute('/settings/tokens');
  const dialog = await openCreate(user);

  await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'forever');
  await user.click(dialog.getByRole('combobox', { name: 'Expires' }));
  const options = within(await screen.findByRole('listbox'));
  expect(options.getAllByRole('option').map((o) => o.textContent)).toEqual([
    '30 days',
    '90 days',
    '1 year',
    'No expiry',
  ]);
  await user.click(options.getByRole('option', { name: 'No expiry' }));
  await user.click(dialog.getByRole('button', { name: 'Create token' }));

  expect(await screen.findByRole('dialog', { name: 'Token created' })).toBeInTheDocument();
  expect(calls[0]?.body).toEqual({ name: 'forever', expires_in_days: null });
});

test('a token needs a name', async () => {
  const { calls } = serveAccount();
  const { user } = renderRoute('/settings/tokens');
  const dialog = await openCreate(user);

  await user.click(dialog.getByRole('button', { name: 'Create token' }));
  expect(await dialog.findByText('Enter a name for this token.')).toBeInTheDocument();
  expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  expect(calls).toEqual([]);
});

test("the server's refusal, such as the token limit, is shown as it wrote it", async () => {
  serveAccount();
  server.use(
    http.post(`${API}/me/tokens`, () =>
      apiError(409, 'conflict', 'You have reached the limit of 100 API tokens. Revoke one first.'),
    ),
  );
  const { user } = renderRoute('/settings/tokens');
  const dialog = await openCreate(user);
  await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'one too many');
  await user.click(dialog.getByRole('button', { name: 'Create token' }));

  expect(
    await dialog.findByText('You have reached the limit of 100 API tokens. Revoke one first.'),
  ).toBeInTheDocument();
  // Still the form, with the name kept.
  expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('one too many');
});

test('tokens show their prefix, when they were created, last used and expire', async () => {
  serveAccount({
    tokens: [
      fxToken({
        id: 'tok_1',
        name: 'ci',
        last_used_at: Date.now() - 2 * HOUR,
        expires_at: Date.UTC(2027, 1, 8, 12),
      }),
      fxToken({ id: 'tok_2', name: 'laptop', prefix: 'pw_zyxwvuts', expires_at: null }),
      fxToken({ id: 'tok_3', name: 'old', expires_at: Date.now() - DAY }),
    ],
  });
  renderRoute('/settings/tokens');
  const list = within(await screen.findByRole('list', { name: 'Your API tokens' }));
  const [ci, laptop, old] = list.getAllByRole('listitem');

  expect(ci).toHaveTextContent('ci');
  expect(within(ci as HTMLElement).getByText('pw_abcdefgh').tagName).toBe('CODE');
  expect(ci).toHaveTextContent('Created Nov 1, 2026');
  expect(ci).toHaveTextContent('Last used 2 hours ago');
  expect(ci).toHaveTextContent('Expires Feb 8, 2027');

  expect(laptop).toHaveTextContent('pw_zyxwvuts');
  expect(laptop).toHaveTextContent('Never used');
  expect(laptop).toHaveTextContent('Expires Never');

  expect(within(old as HTMLElement).getByText('Expired')).toBeInTheDocument();
});

test('revoking a token asks first', async () => {
  const { calls } = serveAccount({ tokens: [fxToken({ id: 'tok_1', name: 'ci' })] });
  const { user } = renderRoute('/settings/tokens');
  const card = within(await tokensCard());

  await user.click(await card.findByRole('button', { name: 'Revoke ci' }));
  const dialog = within(await screen.findByRole('alertdialog', { name: 'Revoke this token?' }));
  expect(dialog.getByText(/ci stops working at once/)).toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(calls).toEqual([]);
  expect(card.getByText('ci')).toBeInTheDocument();

  await user.click(card.getByRole('button', { name: 'Revoke ci' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke token' }),
  );
  expect(await screen.findByText(t('web.tokens.revoked'))).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'DELETE', path: '/me/tokens/tok_1', body: undefined }]);
  await waitFor(() => expect(card.queryByText('ci')).not.toBeInTheDocument());
});

test('a token that cannot be revoked shows why and stays', async () => {
  serveAccount({ tokens: [fxToken({ id: 'tok_1', name: 'ci' })] });
  server.use(
    http.delete(`${API}/me/tokens/tok_1`, () =>
      apiError(404, 'not_found', 'This API token does not exist, or it was already revoked.'),
    ),
  );
  const { user } = renderRoute('/settings/tokens');
  await user.click(await within(await tokensCard()).findByRole('button', { name: 'Revoke ci' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  await user.click(dialog.getByRole('button', { name: 'Revoke token' }));
  expect(
    await dialog.findByText('This API token does not exist, or it was already revoked.'),
  ).toBeInTheDocument();
});

test('the empty state points agents to the connect page', async () => {
  serveAccount();
  renderRoute('/settings/tokens');
  const card = within(await tokensCard());
  expect(await card.findByText('No API tokens yet')).toBeInTheDocument();
  expect(card.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute('href', '/connect');
});

test('the token list shows a skeleton while it loads', async () => {
  serveAccount();
  server.use(http.get(`${API}/me/tokens`, () => delay('infinite')));
  renderRoute('/settings/tokens');
  const card = within(await tokensCard());
  expect(await card.findByRole('status', { name: 'Loading API tokens' })).toBeInTheDocument();
});

test('a failed token list shows why and can be retried', async () => {
  serveAccount();
  let fail = true;
  server.use(
    http.get(`${API}/me/tokens`, () =>
      fail
        ? apiError(500, 'internal', 'The token list is unavailable.')
        : HttpResponse.json({ items: [fxToken({ name: 'ci' })], next_cursor: null }),
    ),
  );
  const { user } = renderRoute('/settings/tokens');
  const card = within(await tokensCard());
  expect(await card.findByText('The token list is unavailable.')).toBeInTheDocument();

  fail = false;
  await user.click(card.getByRole('button', { name: 'Retry' }));
  expect(await card.findByText('ci')).toBeInTheDocument();
});

test('SSO users manage tokens too', async () => {
  serveAccount({ me: { kind: 'oidc', credentials: null, role: 'member' } });
  renderRoute('/settings/tokens', { config: { oidc: { enabled: true, display_name: 'Acme' } } });
  const card = within(await tokensCard());
  expect(await card.findByRole('button', { name: 'Create token' })).toBeInTheDocument();
});
