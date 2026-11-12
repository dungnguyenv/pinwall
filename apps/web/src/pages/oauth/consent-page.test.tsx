import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import type { OAuthConsentRequest } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { browser } from '../../lib/navigation.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';

const t = i18n.t;
const CONSENT_URL = '/oauth/consent?request=req_1';
const CALLBACK = 'http://localhost:33418/callback?code=x';

function consentRequest(o: Partial<OAuthConsentRequest> = {}): OAuthConsentRequest {
  return {
    client_name: 'Claude Code',
    client_uri: null,
    redirect_host: 'localhost:33418',
    scopes: ['mcp'],
    user: { name: 'Ada', email: 'ada@example.com' },
    ...o,
  };
}

/** Serves the request `req_1` and its decision, recording each decision body. */
function serveConsent(
  o: { request?: OAuthConsentRequest; decide?: () => Response | Promise<Response> } = {},
) {
  const decisions: unknown[] = [];
  server.use(
    http.get(`${API}/oauth/requests/req_1`, () => HttpResponse.json(o.request ?? consentRequest())),
    http.post(`${API}/oauth/requests/req_1/decision`, async ({ request }) => {
      decisions.push(await request.json());
      return o.decide ? o.decide() : HttpResponse.json({ redirect_to: CALLBACK });
    }),
  );
  return decisions;
}

/** Watches full page loads instead of letting jsdom refuse them. */
function watchAssign() {
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  onTestFinished(() => assign.mockRestore());
  return assign;
}

const heading = (client = 'Claude Code') =>
  screen.findByRole('heading', { level: 1, name: `${client} wants to connect to your Pinwall` });

beforeEach(() => {
  document.title = '';
});

test('shows who asks, where it returns and as whom', async () => {
  serveConsent();
  renderRoute(CONSENT_URL, { me: fx.me({ name: 'Ada' }) });

  expect(await heading()).toBeInTheDocument();
  expect(t('web.consent.access')).toBe(
    'It will act as you in Pinwall: read projects, artifacts and comments, publish new versions, reply to and resolve comments, and manage share links.',
  );
  expect(screen.getByText(t('web.consent.access'))).toBeInTheDocument();
  expect(screen.getByText('mcp')).toBeInTheDocument();
  expect(screen.getByText('After you choose, you go back to localhost:33418')).toBeInTheDocument();
  expect(screen.getByText(/Ada \(ada@example\.com\)/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Not you?' })).toBeInTheDocument();

  // No shell: the consent card stands alone.
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

  // Neither answer is chosen for the person: a stray Enter does nothing.
  const allow = screen.getByRole('button', { name: 'Allow' });
  const deny = screen.getByRole('button', { name: 'Deny' });
  expect(allow).not.toHaveFocus();
  expect(deny).not.toHaveFocus();
  await waitFor(() => expect(document.title).toBe('Allow access · Pinwall'));
});

test('a person without an email is named alone', async () => {
  serveConsent({ request: consentRequest({ user: { name: 'Ada', email: null } }) });
  renderRoute(CONSENT_URL);
  expect(await heading()).toBeInTheDocument();
  expect(screen.getByText('Signed in as Ada')).toBeInTheDocument();
});

test('client name and uri are shown as text', async () => {
  serveConsent({
    request: consentRequest({
      client_name: '<b>Pinwall</b> Official',
      client_uri: 'javascript:alert(1)',
    }),
  });
  renderRoute(CONSENT_URL);

  const title = await heading('<b>Pinwall</b> Official');
  expect(title).toHaveTextContent('<b>Pinwall</b> Official wants to connect to your Pinwall');
  expect(title.querySelector('b')).toBeNull();
  expect(document.querySelector('main b')).toBeNull();
  expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  expect(screen.queryAllByRole('link')).toEqual([]);
  expect(document.querySelector('a[href^="javascript"]')).toBeNull();
});

test('allow and deny post the decision and follow redirect_to', async () => {
  const assign = watchAssign();
  const decisions = serveConsent();
  const { user } = renderRoute(CONSENT_URL);
  await heading();

  // A double click is one decision.
  await user.dblClick(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith(CALLBACK));
  expect(assign).toHaveBeenCalledOnce();
  expect(decisions).toEqual([{ approve: true }]);
  expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent(
    'You allowed Claude Code. Going back to localhost:33418.',
  );
});

test('deny posts approve false and follows redirect_to', async () => {
  const assign = watchAssign();
  const denied = 'http://localhost:33418/callback?error=access_denied';
  const decisions = serveConsent({ decide: () => HttpResponse.json({ redirect_to: denied }) });
  const { user } = renderRoute(CONSENT_URL);
  await heading();

  await user.click(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith(denied));
  expect(decisions).toEqual([{ approve: false }]);
  // Pressing the other one now sends nothing.
  await user.click(screen.getByRole('button', { name: 'Allow' }));
  expect(decisions).toEqual([{ approve: false }]);
  expect(screen.getByRole('status')).toHaveTextContent('You denied Claude Code.');
});

test('a decision without redirect_to goes nowhere', async () => {
  const assign = watchAssign();
  serveConsent({ decide: () => HttpResponse.json({}) });
  const { user } = renderRoute(CONSENT_URL);
  await heading();

  await user.click(screen.getByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('web.error.invalid_response'));
  expect(assign).not.toHaveBeenCalled();
});

test('a redirect_to that would run script is not followed', async () => {
  const assign = watchAssign();
  serveConsent({ decide: () => HttpResponse.json({ redirect_to: 'javascript:alert(1)' }) });
  const { user } = renderRoute(CONSENT_URL);
  await heading();

  await user.click(screen.getByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('web.consent.unsafeRedirect'));
  expect(assign).not.toHaveBeenCalled();
});

test('a failed decision can be tried again', async () => {
  const assign = watchAssign();
  let fail = true;
  const decisions = serveConsent({
    decide: () =>
      fail
        ? apiError(500, 'internal', 'Pinwall ran into an unexpected problem.')
        : HttpResponse.json({ redirect_to: CALLBACK }),
  });
  const { user } = renderRoute(CONSENT_URL);
  await heading();

  await user.click(screen.getByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Pinwall ran into an unexpected problem.',
  );
  const allow = screen.getByRole('button', { name: 'Allow' });
  expect(allow).toBeEnabled();

  fail = false;
  await user.click(allow);
  await waitFor(() => expect(assign).toHaveBeenCalledWith(CALLBACK));
  expect(decisions).toEqual([{ approve: true }, { approve: true }]);
});

test('an expired request shows the server message', async () => {
  server.use(
    http.get(`${API}/oauth/requests/req_1`, () =>
      apiError(404, 'not_found', 'This authorization request has expired.'),
    ),
  );
  renderRoute(CONSENT_URL);

  expect(await screen.findByText('This authorization request has expired.')).toBeInTheDocument();
  expect(t('web.consent.restart')).toBe('Start the connection again from your agent.');
  expect(screen.getByText(t('web.consent.restart'))).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
});

test('a request that ends before the decision says so', async () => {
  const assign = watchAssign();
  serveConsent({
    decide: () => apiError(410, 'gone', 'This authorization request was already answered.'),
  });
  const { user } = renderRoute(CONSENT_URL);
  await heading();

  await user.click(screen.getByRole('button', { name: 'Allow' }));
  expect(
    await screen.findByText('This authorization request was already answered.'),
  ).toBeInTheDocument();
  expect(screen.getByText(t('web.consent.restart'))).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

test('a link without a request says how to start again', async () => {
  renderRoute('/oauth/consent');
  expect(await screen.findByText(t('web.consent.noRequest'))).toBeInTheDocument();
  expect(screen.getByText(t('web.consent.restart'))).toBeInTheDocument();
});

test('a request that fails to load can be retried', async () => {
  let fail = true;
  server.use(
    http.get(`${API}/oauth/requests/req_1`, () =>
      fail
        ? new HttpResponse('<html>Bad gateway</html>', { status: 502 })
        : HttpResponse.json(consentRequest()),
    ),
  );
  const { user } = renderRoute(CONSENT_URL);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(t('web.error.unavailable'));
  fail = false;
  await user.click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(await heading()).toBeInTheDocument();
});

/** Signs in with the owner password on the sign-in page. */
async function signInWithPassword(user: ReturnType<typeof renderRoute>['user']) {
  server.use(http.post(`${API}/auth/password/sign-in`, () => HttpResponse.json(fx.me())));
  await user.type(await screen.findByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

test('a signed-out visitor signs in first and comes back', async () => {
  serveConsent();
  const { user, router } = renderRoute(CONSENT_URL, { me: null });

  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(router.state.location.search).toBe('?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1');

  await signInWithPassword(user);
  expect(await heading()).toBeInTheDocument();
  expect(router.state.location.pathname + router.state.location.search).toBe(CONSENT_URL);
});

test('not you? signs out and returns here after sign-in', async () => {
  serveConsent();
  const signedOut = vi.fn();
  server.use(
    http.post(`${API}/auth/sign-out`, () => {
      signedOut();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { user, router } = renderRoute(CONSENT_URL);
  await heading();

  await user.click(screen.getByRole('button', { name: 'Not you?' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  // choose_account: behind single sign-on the provider would otherwise sign the same person back in.
  expect(router.state.location.search).toBe(
    '?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1&choose_account=1',
  );
  expect(signedOut).toHaveBeenCalledOnce();

  await signInWithPassword(user);
  expect(await heading()).toBeInTheDocument();
  expect(router.state.location.pathname + router.state.location.search).toBe(CONSENT_URL);
});

test('not you? behind single sign-on asks the provider to pick another account', async () => {
  serveConsent();
  server.use(http.post(`${API}/auth/sign-out`, () => new HttpResponse(null, { status: 204 })));
  const { user } = renderRoute(CONSENT_URL, {
    config: { oidc: { enabled: true, display_name: 'Zitadel' } },
  });
  await heading();

  await user.click(screen.getByRole('button', { name: 'Not you?' }));
  const sso = await screen.findByRole('link', { name: 'Continue with Zitadel' });
  expect(sso).toHaveAttribute(
    'href',
    '/auth/oidc/start?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1&prompt=select_account',
  );
});
