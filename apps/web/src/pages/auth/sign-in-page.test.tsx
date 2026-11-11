import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { RouteObject } from 'react-router';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { qk } from '../../api/keys.ts';
import { buildRoutes } from '../../app/routes.tsx';
import i18n from '../../i18n.ts';
import { browser } from '../../lib/navigation.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: vi.fn(),
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

const t = i18n.t;
const PASSWORD = 'correct horse battery';

const CEREMONY = {
  ceremony_id: 'c2',
  options: { challenge: 'Y2hhbGxlbmdlLTI', rpId: 'localhost', allowCredentials: [] },
};

const ASSERTION = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key' as const,
  response: {
    authenticatorData: 'YXV0aA',
    clientDataJSON: 'e30',
    signature: 'c2ln',
    userHandle: 'dXNyXzE',
  },
  clientExtensionResults: {},
  authenticatorAttachment: 'platform' as const,
};

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(true);
  vi.mocked(startAuthentication).mockReset().mockResolvedValue(ASSERTION);
});

/** The app's routes, with plain pages where sign-in may land. */
function routes(): RouteObject[] {
  return [
    { path: '/', element: <p>Home page</p> },
    { path: '/projects/p1', element: <p>Project page</p> },
    ...buildRoutes(),
  ];
}

/** Serves password sign-in, answering with `respond` (the owner by default), and records bodies. */
function servePassword(respond: () => Response = () => HttpResponse.json(fx.me())) {
  const sent: unknown[] = [];
  server.use(
    http.post(`${API}/auth/password/sign-in`, async ({ request }) => {
      sent.push(await request.json());
      return respond();
    }),
  );
  return sent;
}

function servePasskey() {
  const sent = { options: 0, signIn: [] as unknown[] };
  server.use(
    http.post(`${API}/auth/passkey/options`, () => {
      sent.options += 1;
      return HttpResponse.json(CEREMONY);
    }),
    http.post(`${API}/auth/passkey/sign-in`, async ({ request }) => {
      sent.signIn.push(await request.json());
      return HttpResponse.json(fx.me());
    }),
  );
  return sent;
}

function passwordInput(): HTMLElement {
  return screen.getByLabelText('Password');
}

test('password sign-in returns to return_to', async () => {
  const sent = servePassword();
  const { user, router, queryClient } = renderRoute('/signin?return_to=%2Fprojects%2Fp1', {
    me: null,
    routes: routes(),
  });

  expect(
    await screen.findByRole('heading', { level: 1, name: 'Sign in to Pinwall' }),
  ).toBeInTheDocument();
  expect(await screen.findByLabelText('Password')).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  await user.type(passwordInput(), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText('Project page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/projects/p1');
  expect(router.state.historyAction).toBe('REPLACE');
  expect(sent).toEqual([{ password: PASSWORD }]);
  expect(queryClient.getQueryData(qk.me)).toEqual(fx.me());
});

test('next is accepted as an alias for return_to', async () => {
  servePassword();
  const { user, router } = renderRoute('/signin?next=%2Fprojects%2Fp1', {
    me: null,
    routes: routes(),
  });
  await user.type(await screen.findByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Project page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/projects/p1');
});

test.each([
  ['%2F%2Fevil.example'],
  ['%2F.%2F%2Fevil.com'],
  ['https%3A%2F%2Fevil.example%2Fprojects%2Fp1'],
])('hostile return_to falls back to / (%s)', async (returnTo) => {
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  onTestFinished(() => assign.mockRestore());
  servePassword();
  const { user, router } = renderRoute(`/signin?return_to=${returnTo}`, {
    me: null,
    routes: routes(),
  });
  await user.type(await screen.findByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  expect(assign).not.toHaveBeenCalled();
});

test('a server-route return_to does a full navigation', async () => {
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  onTestFinished(() => assign.mockRestore());
  servePassword();
  const { user } = renderRoute('/signin?return_to=%2Fa%2Fart_1%2Fraw', { me: null });
  await user.type(await screen.findByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/a/art_1/raw'));
  expect(assign).toHaveBeenCalledOnce();
});

test('a wrong password shows the server message and keeps the page', async () => {
  servePassword(() => apiError(401, 'invalid_credentials', 'Wrong password.'));
  const { user, router, queryClient } = renderRoute('/signin', { me: null, routes: routes() });
  await user.type(await screen.findByLabelText('Password'), 'not it at all');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.');
  expect(passwordInput()).toHaveAttribute('aria-invalid', 'true');
  expect(passwordInput()).toHaveFocus();
  expect(router.state.location.pathname).toBe('/signin');
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  expect(queryClient.getQueryData(qk.me)).toBeNull();
});

test('an empty password is caught before any request', async () => {
  const sent = servePassword();
  const { user } = renderRoute('/signin', { me: null });
  await screen.findByLabelText('Password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(t('web.signin.passwordRequired'))).toBeInTheDocument();
  expect(sent).toEqual([]);
});

test('passkey sign-in', async () => {
  const sent = servePasskey();
  const { user, router } = renderRoute('/signin', { me: null, routes: routes() });

  await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  expect(sent.options).toBe(1);
  expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: CEREMONY.options });
  expect(sent.signIn).toEqual([{ ceremony_id: 'c2', response: ASSERTION }]);
});

test('a cancelled passkey prompt keeps the page and says so', async () => {
  vi.mocked(startAuthentication).mockRejectedValue(new DOMException('', 'NotAllowedError'));
  const sent = servePasskey();
  const { user, router } = renderRoute('/signin', { me: null });

  await user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));

  expect(await screen.findByText(t('web.passkey.cancelled'))).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/signin');
  expect(sent.signIn).toEqual([]);
  expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
});

test('the OIDC button uses the configured label and carries return_to', async () => {
  const { user } = renderRoute('/signin?return_to=%2Fprojects%2Fp1', {
    me: null,
    config: { oidc: { enabled: true, display_name: 'Zitadel' } },
  });

  const sso = await screen.findByRole('link', { name: 'Continue with Zitadel' });
  expect(sso).toHaveAttribute('href', '/auth/oidc/start?return_to=%2Fprojects%2Fp1');
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).not.toBeInTheDocument();

  const toggle = screen.getByRole('button', { name: t('web.signin.ownerToggle') });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(passwordInput()).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeInTheDocument();
});

test('choose_account makes the OIDC button ask the provider to pick an account', async () => {
  renderRoute('/signin?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1&choose_account=1', {
    me: null,
    config: { oidc: { enabled: true, display_name: 'Zitadel' } },
  });
  const sso = await screen.findByRole('link', { name: 'Continue with Zitadel' });
  expect(sso).toHaveAttribute(
    'href',
    '/auth/oidc/start?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1&prompt=select_account',
  );
});

test('without choose_account the OIDC button does not ask for another account', async () => {
  renderRoute('/signin?return_to=%2Fprojects%2Fp1&choose_account=yes', {
    me: null,
    config: { oidc: { enabled: true, display_name: 'Zitadel' } },
  });
  const sso = await screen.findByRole('link', { name: 'Continue with Zitadel' });
  expect(sso).toHaveAttribute('href', '/auth/oidc/start?return_to=%2Fprojects%2Fp1');
});

test('the OIDC button has a generic label when none is configured', async () => {
  renderRoute('/signin', { me: null, config: { oidc: { enabled: true, display_name: null } } });
  const sso = await screen.findByRole('link', {
    name: t('web.signin.oidc', { name: t('web.signin.oidcDefaultName') }),
  });
  expect(sso).toHaveAttribute('href', '/auth/oidc/start?return_to=%2F');
});

test('passkeys unavailable leaves the password and says why', async () => {
  renderRoute('/signin', { me: null, config: { passkeys_available: false } });
  expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).not.toBeInTheDocument();
  expect(screen.getByText(t('auth.passkeysUnavailable'))).toBeInTheDocument();
});

test('before setup the page says how to finish it', async () => {
  renderRoute('/signin', {
    me: null,
    config: { setup_required: true, oidc: { enabled: true, display_name: 'Zitadel' } },
  });
  expect(await screen.findByText(t('auth.setup.required'))).toBeInTheDocument();
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Continue with Zitadel' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).not.toBeInTheDocument();
});

test('a signed-in visitor is sent on', async () => {
  const { router } = renderRoute('/signin?return_to=%2Fprojects%2Fp1', { routes: routes() });
  expect(await screen.findByText('Project page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/projects/p1');
  expect(router.state.historyAction).toBe('REPLACE');
});

test("signing in forgets the previous person's cached data", async () => {
  servePassword();
  const { user, queryClient } = renderRoute('/signin', { me: null, routes: routes() });
  queryClient.setQueryData(qk.projects(false), fx.page([fx.project({ name: 'Someone else' })]));

  await user.type(await screen.findByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByText('Home page')).toBeInTheDocument();
  expect(queryClient.getQueryData(qk.projects(false))).toBeUndefined();
  expect(queryClient.getQueryData(qk.me)).toEqual(fx.me());
  expect(queryClient.getQueryData(qk.publicConfig)).toEqual(fx.config());
});

test('a public configuration that fails to load can be retried', async () => {
  let calls = 0;
  server.use(
    http.get(`${API}/config/public`, () => {
      calls += 1;
      return calls === 1
        ? new HttpResponse('<html>Bad gateway</html>', { status: 502 })
        : HttpResponse.json(fx.config());
    }),
  );
  const { user } = renderRoute('/signin', { me: null });
  expect(await screen.findByText(t('web.error.unavailable'))).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByLabelText('Password')).toBeInTheDocument();
});
