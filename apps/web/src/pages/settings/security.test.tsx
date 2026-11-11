import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, expect, test, vi } from 'vitest';
import i18n from '../../i18n.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import {
  fxPasskey,
  LAST_CREDENTIAL_MESSAGE,
  PASSKEY_CEREMONY,
  serveAccount,
} from '../../test/settings.ts';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: vi.fn(),
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

const t = i18n.t;
const DAY = 86_400_000;

const REGISTRATION = {
  id: 'cred-9',
  rawId: 'cred-9',
  type: 'public-key' as const,
  response: { clientDataJSON: 'e30', attestationObject: 'YXR0', transports: ['internal'] },
  clientExtensionResults: {},
  authenticatorAttachment: 'platform' as const,
};

beforeEach(() => {
  serveSidebar();
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(true);
  vi.mocked(startRegistration).mockReset().mockResolvedValue(REGISTRATION);
});

const passwordCard = () => screen.findByRole('region', { name: 'Password' });
const passkeysCard = () => screen.findByRole('region', { name: 'Passkeys' });

// --- Password ---

test('change password sends current and new', async () => {
  const { calls } = serveAccount();
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  await user.type(await card.findByLabelText('Current password'), 'old password 1');
  await user.type(card.getByLabelText('New password'), 'new password 12');
  await user.type(card.getByLabelText('Confirm new password'), 'new password 12');
  await user.click(card.getByRole('button', { name: 'Change password' }));

  expect(await screen.findByText(t('web.security.passwordChanged'))).toBeInTheDocument();
  expect(t('web.security.passwordChanged')).toBe(
    'Password changed. Your other sessions were signed out.',
  );
  expect(calls).toEqual([
    {
      method: 'PUT',
      path: '/me/password',
      body: { current_password: 'old password 1', new_password: 'new password 12' },
    },
  ]);
  // The form is empty again, ready for the next change.
  expect(card.getByLabelText('Current password')).toHaveValue('');
  expect(card.getByLabelText('New password')).toHaveValue('');
  expect(card.getByLabelText('Confirm new password')).toHaveValue('');
});

test('a wrong current password shows the server message at that field', async () => {
  serveAccount();
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  const current = await card.findByLabelText('Current password');
  await user.type(current, 'not my password');
  await user.type(card.getByLabelText('New password'), 'new password 12');
  await user.type(card.getByLabelText('Confirm new password'), 'new password 12');
  await user.click(card.getByRole('button', { name: 'Change password' }));

  const message = await card.findByText('Wrong password.');
  expect(message).toBeInTheDocument();
  expect(current).toHaveAccessibleDescription('Wrong password.');
  expect(current).toHaveFocus();
  // The new password stays typed; only the current one needs fixing.
  expect(card.getByLabelText('New password')).toHaveValue('new password 12');
});

test('a new password is checked before anything is sent', async () => {
  const { calls } = serveAccount();
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  await user.click(await card.findByRole('button', { name: 'Change password' }));
  expect(await card.findByText('Enter your current password.')).toBeInTheDocument();
  expect(card.getByLabelText('Current password')).toHaveFocus();

  await user.type(card.getByLabelText('Current password'), 'old password 1');
  await user.type(card.getByLabelText('New password'), 'short');
  await user.click(card.getByRole('button', { name: 'Change password' }));
  expect(await card.findByText(t('auth.passwordTooShort', { min: 12 }))).toBeInTheDocument();
  expect(card.getByLabelText('New password')).toHaveFocus();

  await user.clear(card.getByLabelText('New password'));
  await user.type(card.getByLabelText('New password'), 'new password 12');
  await user.type(card.getByLabelText('Confirm new password'), 'new password 13');
  await user.click(card.getByRole('button', { name: 'Change password' }));
  expect(await card.findByText('The passwords do not match.')).toBeInTheDocument();
  expect(card.getByLabelText('Confirm new password')).toHaveFocus();
  expect(calls).toEqual([]);
});

test("the server's complaint about the new password shows at that field", async () => {
  serveAccount();
  server.use(
    http.put(`${API}/me/password`, () =>
      apiError(400, 'bad_request', 'Use at least 12 characters.', { field: 'password' }),
    ),
  );
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  await user.type(await card.findByLabelText('Current password'), 'old password 1');
  await user.type(card.getByLabelText('New password'), 'new password 12');
  await user.type(card.getByLabelText('Confirm new password'), 'new password 12');
  await user.click(card.getByRole('button', { name: 'Change password' }));

  expect(await card.findByText('Use at least 12 characters.')).toBeInTheDocument();
  expect(card.getByLabelText('New password')).toHaveAccessibleDescription(
    expect.stringContaining('Use at least 12 characters.'),
  );
});

test('a rate limit is shown in the card, as the server wrote it', async () => {
  serveAccount();
  server.use(
    http.put(`${API}/me/password`, () =>
      apiError(429, 'rate_limited', 'Too many attempts. Try again in 5 minutes.'),
    ),
  );
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  await user.type(await card.findByLabelText('Current password'), 'old password 1');
  await user.type(card.getByLabelText('New password'), 'new password 12');
  await user.type(card.getByLabelText('Confirm new password'), 'new password 12');
  await user.click(card.getByRole('button', { name: 'Change password' }));

  expect(await card.findByRole('alert')).toHaveTextContent(
    'Too many attempts. Try again in 5 minutes.',
  );
});

test('a passkey-only owner adds a password without a current one', async () => {
  const { calls } = serveAccount({ password: null, passkeys: [fxPasskey()] });
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  expect(await card.findByLabelText('New password')).toBeInTheDocument();
  expect(card.queryByLabelText('Current password')).not.toBeInTheDocument();
  expect(card.queryByRole('button', { name: 'Remove password' })).not.toBeInTheDocument();

  await user.type(card.getByLabelText('New password'), 'new password 12');
  await user.type(card.getByLabelText('Confirm new password'), 'new password 12');
  await user.click(card.getByRole('button', { name: 'Add password' }));

  expect(await screen.findByText(t('web.security.passwordAdded'))).toBeInTheDocument();
  expect(calls).toEqual([
    { method: 'PUT', path: '/me/password', body: { new_password: 'new password 12' } },
  ]);
  // Now there is a password to change, and with a passkey it can be removed.
  expect(await card.findByLabelText('Current password')).toBeInTheDocument();
  expect(card.getByRole('button', { name: 'Remove password' })).toBeInTheDocument();
});

test('Remove password appears only when a passkey is left to sign in with', async () => {
  serveAccount({ passkeys: [] });
  renderRoute('/settings/security');
  const card = within(await passwordCard());
  expect(await card.findByRole('button', { name: 'Change password' })).toBeInTheDocument();
  expect(card.queryByRole('button', { name: 'Remove password' })).not.toBeInTheDocument();
});

test('removing the password asks first, then removes it', async () => {
  const { calls } = serveAccount({ passkeys: [fxPasskey()] });
  const { user } = renderRoute('/settings/security');
  const card = within(await passwordCard());

  await user.click(await card.findByRole('button', { name: 'Remove password' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Remove your password?' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(calls).toEqual([]);

  await user.click(card.getByRole('button', { name: 'Remove password' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove password' }),
  );
  expect(await screen.findByText(t('web.security.passwordRemoved'))).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'DELETE', path: '/me/password', body: undefined }]);
  // The card is the passkey-only one now.
  expect(await card.findByRole('button', { name: 'Add password' })).toBeInTheDocument();
});

test('removing the last credential shows the server refusal', async () => {
  serveAccount({ passkeys: [fxPasskey()] });
  server.use(
    http.delete(`${API}/me/password`, () => apiError(409, 'conflict', LAST_CREDENTIAL_MESSAGE)),
  );
  const { user } = renderRoute('/settings/security');

  await user.click(
    await within(await passwordCard()).findByRole('button', { name: 'Remove password' }),
  );
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Remove password' }));

  expect(await within(dialog).findByText(LAST_CREDENTIAL_MESSAGE)).toBeInTheDocument();
  expect(t('auth.lastCredential')).toBe(LAST_CREDENTIAL_MESSAGE);
  // The dialog stays, so the person can read why and cancel.
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
});

// --- Passkeys ---

test('passkeys list their name, when they were added and when they were last used', async () => {
  serveAccount({
    passkeys: [
      fxPasskey({ id: 'pk_1', name: 'MacBook', last_used_at: Date.now() - 3 * DAY }),
      fxPasskey({ id: 'pk_2', name: 'Phone', last_used_at: null }),
    ],
  });
  renderRoute('/settings/security');
  const list = within(await screen.findByRole('list', { name: 'Your passkeys' }));
  const [macbook, phone] = list.getAllByRole('listitem');
  expect(macbook).toHaveTextContent('MacBook');
  expect(macbook).toHaveTextContent('Added Nov 1, 2026');
  expect(macbook).toHaveTextContent('Last used 3 days ago');
  expect(phone).toHaveTextContent('Phone');
  expect(phone).toHaveTextContent('Never used');
});

test('passkeys: add, rename, delete', async () => {
  const { calls } = serveAccount({ passkeys: [fxPasskey({ id: 'pk_1', name: 'MacBook' })] });
  const { user } = renderRoute('/settings/security');
  const card = within(await passkeysCard());

  // Add: the name first, then the browser's prompt, then the server.
  await user.click(await card.findByRole('button', { name: 'Add a passkey' }));
  const addDialog = within(await screen.findByRole('dialog', { name: 'Add a passkey' }));
  await user.type(addDialog.getByRole('textbox', { name: /^Name/ }), 'Work laptop');
  await user.click(addDialog.getByRole('button', { name: 'Continue' }));

  expect(await screen.findByText(t('web.security.passkeyAdded'))).toBeInTheDocument();
  expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: PASSKEY_CEREMONY.options });
  expect(calls).toEqual([
    { method: 'POST', path: '/me/passkeys/options', body: undefined },
    {
      method: 'POST',
      path: '/me/passkeys',
      body: { ceremony_id: 'c1', response: REGISTRATION, name: 'Work laptop' },
    },
  ]);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await card.findByText('Work laptop')).toBeInTheDocument();

  // Rename.
  calls.length = 0;
  await user.click(card.getByRole('button', { name: 'Rename MacBook' }));
  const renameDialog = within(await screen.findByRole('dialog', { name: 'Rename passkey' }));
  const name = renameDialog.getByRole('textbox', { name: 'Name' });
  expect(name).toHaveValue('MacBook');
  await user.clear(name);
  await user.type(name, 'Desk key');
  await user.click(renameDialog.getByRole('button', { name: 'Save' }));
  expect(await card.findByText('Desk key')).toBeInTheDocument();
  expect(card.queryByText('MacBook')).not.toBeInTheDocument();
  expect(calls).toEqual([
    { method: 'PATCH', path: '/me/passkeys/pk_1', body: { name: 'Desk key' } },
  ]);

  // Delete asks first.
  calls.length = 0;
  await user.click(card.getByRole('button', { name: 'Delete Desk key' }));
  const confirm = within(await screen.findByRole('alertdialog', { name: 'Delete this passkey?' }));
  await user.click(confirm.getByRole('button', { name: 'Cancel' }));
  expect(calls).toEqual([]);
  await user.click(card.getByRole('button', { name: 'Delete Desk key' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete passkey' }),
  );
  await waitFor(() => expect(card.queryByText('Desk key')).not.toBeInTheDocument());
  expect(calls).toEqual([{ method: 'DELETE', path: '/me/passkeys/pk_1', body: undefined }]);
  expect(await screen.findByText(t('web.security.passkeyDeleted'))).toBeInTheDocument();
});

test('a passkey without a name is sent without one, and the server names it', async () => {
  const { calls } = serveAccount();
  const { user } = renderRoute('/settings/security');
  await user.click(
    await within(await passkeysCard()).findByRole('button', { name: 'Add a passkey' }),
  );
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue' }),
  );
  expect(await within(await passkeysCard()).findByText('Passkey 1')).toBeInTheDocument();
  expect(calls[1]).toEqual({
    method: 'POST',
    path: '/me/passkeys',
    body: { ceremony_id: 'c1', response: REGISTRATION },
  });
});

test('a cancelled passkey prompt says so and sends nothing', async () => {
  const { calls } = serveAccount();
  vi.mocked(startRegistration).mockRejectedValue(new DOMException('closed', 'NotAllowedError'));
  const { user } = renderRoute('/settings/security');
  await user.click(
    await within(await passkeysCard()).findByRole('button', { name: 'Add a passkey' }),
  );
  const dialog = within(await screen.findByRole('dialog'));
  await user.click(dialog.getByRole('button', { name: 'Continue' }));

  expect(await dialog.findByText(t('web.passkey.cancelled'))).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'POST', path: '/me/passkeys/options', body: undefined }]);
  // Still open, and the person can try again.
  expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
});

test("the server's refusal of a new passkey is shown as it wrote it", async () => {
  serveAccount();
  server.use(
    http.post(`${API}/me/passkeys`, () =>
      apiError(409, 'conflict', 'This passkey is already registered.'),
    ),
  );
  const { user } = renderRoute('/settings/security');
  await user.click(
    await within(await passkeysCard()).findByRole('button', { name: 'Add a passkey' }),
  );
  const dialog = within(await screen.findByRole('dialog'));
  await user.click(dialog.getByRole('button', { name: 'Continue' }));
  expect(await dialog.findByText('This passkey is already registered.')).toBeInTheDocument();
});

test('Add a passkey is disabled, with the reason, when the server cannot do passkeys', async () => {
  serveAccount();
  renderRoute('/settings/security', { config: { passkeys_available: false } });
  const card = within(await passkeysCard());
  expect(await card.findByRole('button', { name: 'Add a passkey' })).toBeDisabled();
  expect(card.getByText(t('auth.passkeysUnavailable'))).toBeInTheDocument();
});

test('Add a passkey is disabled, with the reason, in a browser without WebAuthn', async () => {
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
  serveAccount();
  renderRoute('/settings/security');
  const card = within(await passkeysCard());
  expect(await card.findByRole('button', { name: 'Add a passkey' })).toBeDisabled();
  expect(card.getByText(t('web.security.passkeysBrowser'))).toBeInTheDocument();
  expect(card.queryByText(t('auth.passkeysUnavailable'))).not.toBeInTheDocument();
});

test('deleting the last way to sign in shows the server refusal', async () => {
  serveAccount({ password: null, passkeys: [fxPasskey({ id: 'pk_1', name: 'MacBook' })] });
  const { user } = renderRoute('/settings/security');
  const card = within(await passkeysCard());

  await user.click(await card.findByRole('button', { name: 'Delete MacBook' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Delete passkey' }));
  expect(await within(dialog).findByText(LAST_CREDENTIAL_MESSAGE)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(await card.findByText('MacBook')).toBeInTheDocument();
});

test('the passkey list shows a skeleton while it loads', async () => {
  serveAccount();
  server.use(http.get(`${API}/me/passkeys`, () => delay('infinite')));
  renderRoute('/settings/security');
  const card = within(await passkeysCard());
  expect(await card.findByRole('status', { name: 'Loading passkeys' })).toBeInTheDocument();
  // The rest of the page does not wait for it.
  expect(await passwordCard()).toBeInTheDocument();
});

test('an empty passkey list says what a passkey is for', async () => {
  serveAccount();
  renderRoute('/settings/security');
  const card = within(await passkeysCard());
  expect(await card.findByText('No passkeys yet')).toBeInTheDocument();
  expect(card.getByText(t('web.security.passkeysEmptyHint'))).toBeInTheDocument();
});

test('a failed passkey list shows why and can be retried', async () => {
  serveAccount();
  let fail = true;
  server.use(
    http.get(`${API}/me/passkeys`, () =>
      fail
        ? apiError(500, 'internal', 'The passkey list is unavailable.')
        : HttpResponse.json({ items: [fxPasskey({ name: 'MacBook' })], next_cursor: null }),
    ),
  );
  const { user } = renderRoute('/settings/security');
  const card = within(await passkeysCard());
  expect(await card.findByText('The passkey list is unavailable.')).toBeInTheDocument();

  fail = false;
  await user.click(card.getByRole('button', { name: 'Retry' }));
  expect(await card.findByText('MacBook')).toBeInTheDocument();
});
