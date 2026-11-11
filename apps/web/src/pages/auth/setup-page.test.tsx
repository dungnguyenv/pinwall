import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { RouteObject } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { qk } from '../../api/keys.ts';
import { buildRoutes } from '../../app/routes.tsx';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: vi.fn(),
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

const t = i18n.t;
const INVALID_LINK =
  'This setup link is invalid or has expired. Restart Pinwall to print a new one in the log.';
const ALREADY_DONE = 'Setup is already complete. Sign in instead.';

const CEREMONY = {
  ceremony_id: 'c1',
  options: {
    challenge: 'Y2hhbGxlbmdl',
    rp: { name: 'Pinwall', id: 'localhost' },
    user: { id: 'dXNyXzE', name: 'Ada', displayName: 'Ada' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  },
};

const REGISTRATION = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key' as const,
  response: {
    clientDataJSON: 'e30',
    attestationObject: 'o2NmbXRkbm9uZQ',
    transports: ['internal'],
  },
  clientExtensionResults: {},
  authenticatorAttachment: 'platform' as const,
};

const OWNER = fx.me({ name: 'Ada', email: 'ada@example.com' });

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(true);
  vi.mocked(startRegistration).mockReset().mockResolvedValue(REGISTRATION);
});

/** The app's routes, with a plain page at `/` so a test can see setup finish there. */
function routes(): RouteObject[] {
  return [{ path: '/', element: <p>Home page</p> }, ...buildRoutes()];
}

/**
 * Serves the setup API: the link check (204 unless `check` says otherwise),
 * passkey options and setup itself, and records the body of every request.
 */
function serveSetup(o: { check?: () => Response; setup?: () => Promise<Response> } = {}) {
  const sent = { check: [] as unknown[], options: [] as unknown[], setup: [] as unknown[] };
  server.use(
    http.post(`${API}/auth/setup/check`, async ({ request }) => {
      sent.check.push(await request.json());
      return o.check?.() ?? new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/auth/setup/passkey/options`, async ({ request }) => {
      sent.options.push(await request.json());
      return HttpResponse.json(CEREMONY);
    }),
    http.post(`${API}/auth/setup`, async ({ request }) => {
      sent.setup.push(await request.json());
      return o.setup ? o.setup() : HttpResponse.json(OWNER, { status: 201 });
    }),
  );
  return sent;
}

function passwordInput(): HTMLElement {
  return screen.getByLabelText('Choose a password');
}

test('a valid link shows the form; a bad one shows the server message', async () => {
  const sent = serveSetup();
  renderRoute('/setup?token=tok', { me: null });
  expect(await screen.findByRole('textbox', { name: 'Your name' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Set up Pinwall' })).toBeInTheDocument();
  expect(sent.check).toEqual([{ token: 'tok' }]);
});

test('a dead setup link shows the server message verbatim', async () => {
  serveSetup({ check: () => apiError(403, 'forbidden', INVALID_LINK) });
  renderRoute('/setup?token=old', { me: null });
  expect(await screen.findByText(INVALID_LINK)).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument();
});

test('a used setup link says setup is done and links to sign in', async () => {
  serveSetup({ check: () => apiError(409, 'setup_done', ALREADY_DONE) });
  renderRoute('/setup?token=tok', { me: null });
  expect(await screen.findByText(ALREADY_DONE)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
  expect(screen.queryByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument();
});

test('a failed check that is not about the link can be retried', async () => {
  let calls = 0;
  serveSetup({
    check: () => {
      calls += 1;
      return calls === 1
        ? new HttpResponse('<html>Bad gateway</html>', { status: 502 })
        : new HttpResponse(null, { status: 204 });
    },
  });
  const { user } = renderRoute('/setup?token=tok', { me: null });
  expect(await screen.findByText(t('web.error.unavailable'))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('textbox', { name: 'Your name' })).toBeInTheDocument();
});

test('without a token the page says where the link is', async () => {
  renderRoute('/setup', { me: null });
  expect(await screen.findByText(t('web.setup.noToken'))).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument();
});

test('setup with a password creates the owner and opens the app', async () => {
  const sent = serveSetup();
  const { user, router, queryClient } = renderRoute('/setup?token=tok', {
    me: null,
    config: { setup_required: true },
    routes: routes(),
  });

  await user.click(await screen.findByRole('switch', { name: 'Passkey' }));
  await user.click(screen.getByRole('switch', { name: 'Password' }));
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ada');
  await user.type(screen.getByRole('textbox', { name: /^Email/ }), 'ada@example.com');
  await user.type(passwordInput(), 'correct horse battery');
  await user.type(screen.getByLabelText('Confirm password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  expect(router.state.historyAction).toBe('REPLACE');
  expect(sent.setup).toEqual([
    { token: 'tok', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' },
  ]);
  expect(queryClient.getQueryData(qk.me)).toEqual(OWNER);
  // The configuration read once at setup must not send a later sign-in back to setup.
  expect(queryClient.getQueryData(qk.publicConfig)).toMatchObject({ setup_required: false });
  expect(await screen.findByText(t('web.setup.welcome'))).toBeInTheDocument();
  expect(startRegistration).not.toHaveBeenCalled();
});

test('password rules are checked before submit and the confirmation must match', async () => {
  const sent = serveSetup();
  const { user } = renderRoute('/setup?token=tok', { me: null });

  await user.click(await screen.findByRole('switch', { name: 'Passkey' }));
  await user.click(screen.getByRole('switch', { name: 'Password' }));
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ada');
  await user.type(passwordInput(), 'a'.repeat(11));
  await user.type(screen.getByLabelText('Confirm password'), 'a'.repeat(11));
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText(t('auth.passwordTooShort', { min: 12 }))).toBeInTheDocument();
  expect(passwordInput()).toHaveFocus();
  expect(passwordInput()).toHaveAttribute('aria-invalid', 'true');

  await user.type(passwordInput(), 'a');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));
  expect(await screen.findByText(t('web.setup.passwordMismatch'))).toBeInTheDocument();
  expect(screen.getByLabelText('Confirm password')).toHaveFocus();
  expect(screen.queryByText(t('auth.passwordTooShort', { min: 12 }))).not.toBeInTheDocument();
  expect(sent.setup).toEqual([]);
});

test('a name and at least one sign-in method are required', async () => {
  const sent = serveSetup();
  const { user } = renderRoute('/setup?token=tok', { me: null });

  await user.click(await screen.findByRole('switch', { name: 'Passkey' }));
  await user.type(screen.getByRole('textbox', { name: /^Email/ }), 'not-an-email');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText(t('web.setup.nameRequired'))).toBeInTheDocument();
  expect(screen.getByText(t('web.setup.emailInvalid'))).toBeInTheDocument();
  expect(screen.getByText(t('auth.setup.needCredential'))).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveFocus();
  expect(sent.setup).toEqual([]);
});

test('setup with a passkey runs the ceremony first', async () => {
  const sent = serveSetup();
  const { user, router } = renderRoute('/setup?token=tok', { me: null, routes: routes() });

  expect(await screen.findByRole('switch', { name: 'Passkey' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Password' })).not.toBeChecked();
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), '  Ada ');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  expect(sent.options).toEqual([{ token: 'tok', name: 'Ada' }]);
  expect(startRegistration).toHaveBeenCalledOnce();
  expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: CEREMONY.options });
  expect(sent.setup).toHaveLength(1);
  const body = sent.setup[0] as Record<string, unknown>;
  expect(body).toEqual({
    token: 'tok',
    name: 'Ada',
    passkey: { ceremony_id: 'c1', response: REGISTRATION },
  });
  expect(body).not.toHaveProperty('password');
});

test('a passkey and a password can be set up together', async () => {
  const sent = serveSetup();
  const { user } = renderRoute('/setup?token=tok', { me: null, routes: routes() });

  await user.click(await screen.findByRole('switch', { name: 'Password' }));
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ada');
  await user.type(passwordInput(), 'correct horse battery');
  await user.type(screen.getByLabelText('Confirm password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(sent.setup).toEqual([
    {
      token: 'tok',
      name: 'Ada',
      password: 'correct horse battery',
      passkey: { ceremony_id: 'c1', response: REGISTRATION },
    },
  ]);
});

test('a cancelled passkey prompt keeps the form and says so', async () => {
  vi.mocked(startRegistration).mockRejectedValue(new DOMException('', 'NotAllowedError'));
  const sent = serveSetup();
  const { user, router } = renderRoute('/setup?token=tok', { me: null });

  await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText(t('web.passkey.cancelled'))).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveValue('Ada');
  expect(screen.getByRole('button', { name: 'Create owner account' })).toBeEnabled();
  expect(router.state.location.pathname).toBe('/setup');
  expect(sent.options).toHaveLength(1);
  expect(sent.setup).toEqual([]);
});

test('a refusal from the server is shown as the server worded it', async () => {
  const message = 'Use at least 12 characters.';
  serveSetup({ setup: async () => apiError(400, 'bad_request', message, { field: 'password' }) });
  const { user } = renderRoute('/setup?token=tok', { me: null });

  await user.click(await screen.findByRole('switch', { name: 'Passkey' }));
  await user.click(screen.getByRole('switch', { name: 'Password' }));
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ada');
  await user.type(passwordInput(), 'correct horse battery');
  await user.type(screen.getByLabelText('Confirm password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(passwordInput()).toHaveAttribute('aria-invalid', 'true');
});

test('setup finished elsewhere while the form was open links to sign in', async () => {
  serveSetup({ setup: async () => apiError(409, 'setup_done', ALREADY_DONE) });
  const { user } = renderRoute('/setup?token=tok', { me: null });

  await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
  await user.click(screen.getByRole('button', { name: 'Create owner account' }));

  expect(await screen.findByText(ALREADY_DONE)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
  expect(screen.queryByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument();
});

test('passkeys unavailable leaves password only', async () => {
  serveSetup();
  renderRoute('/setup?token=tok', { me: null, config: { passkeys_available: false } });

  expect(await screen.findByRole('textbox', { name: 'Your name' })).toBeInTheDocument();
  expect(screen.queryAllByRole('switch')).toEqual([]);
  expect(screen.getByText(t('auth.passkeysUnavailable'))).toBeInTheDocument();
  expect(passwordInput()).toBeInTheDocument();
  expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
});

test('a browser without WebAuthn leaves password only', async () => {
  vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
  serveSetup();
  renderRoute('/setup?token=tok', { me: null });

  expect(await screen.findByRole('textbox', { name: 'Your name' })).toBeInTheDocument();
  expect(screen.queryAllByRole('switch')).toEqual([]);
  expect(passwordInput()).toBeInTheDocument();
});

test('the isolation trade-off is explained', async () => {
  serveSetup();
  renderRoute('/setup?token=tok', { me: null, config: { isolation: 'single-domain' } });

  const single = (await screen.findByRole('heading', { name: 'Single domain' })).closest('li');
  const content = screen.getByRole('heading', { name: 'Separate content domain' }).closest('li');
  if (!single || !content) throw new Error('each mode is a list item');
  expect(within(single).getByText(t('web.isolation.current'))).toBeInTheDocument();
  expect(within(content).queryByText(t('web.isolation.current'))).not.toBeInTheDocument();
  expect(within(single).getByText(t('web.isolation.single.body'))).toBeInTheDocument();
  expect(within(content).getByText(t('web.isolation.content.body'))).toBeInTheDocument();
  expect(screen.getByText(t('web.isolation.tradeoff'))).toBeInTheDocument();
});

test('the content-domain mode is marked current when it is', async () => {
  serveSetup();
  renderRoute('/setup?token=tok', { me: null, config: { isolation: 'content-domain' } });

  const content = (await screen.findByRole('heading', { name: 'Separate content domain' })).closest(
    'li',
  );
  if (!content) throw new Error('each mode is a list item');
  expect(within(content).getByText('Current')).toBeInTheDocument();
});

test('submitting twice sends one request', async () => {
  let finish: (response: Response) => void = () => {};
  const sent = serveSetup({
    setup: () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  });
  const { user } = renderRoute('/setup?token=tok', { me: null, routes: routes() });

  await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
  const form = screen.getByRole('button', { name: 'Create owner account' }).closest('form');
  if (!form) throw new Error('the submit button is in a form');
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  await waitFor(() => expect(sent.setup).toHaveLength(1));
  // While setup runs the button is busy and does nothing.
  const busy = screen.getByRole('button', { name: /Create owner account/ });
  expect(busy).toHaveAttribute('aria-busy', 'true');
  await user.click(busy);

  finish(HttpResponse.json(OWNER, { status: 201 }));
  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(sent.options).toHaveLength(1);
  expect(startRegistration).toHaveBeenCalledOnce();
  expect(sent.setup).toHaveLength(1);
});
