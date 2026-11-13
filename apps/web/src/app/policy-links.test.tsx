import { cleanup, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import i18n from '../i18n.ts';
import { fx } from '../test/fixtures.ts';
import { renderRoute } from '../test/render.tsx';
import { API, apiError, server } from '../test/server.ts';
import { abuseHref, safeHttpUrl } from './policy-links.tsx';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const TIMEOUT = { timeout: 5000 };

const POLICY = {
  terms_url: 'https://example.org/terms',
  privacy_url: 'https://example.org/privacy',
  abuse_contact: 'abuse@example.org',
};

test('abuseHref and safeHttpUrl accept email and http(s) only', () => {
  expect(abuseHref('abuse@example.org')).toBe('mailto:abuse@example.org');
  expect(abuseHref('https://example.org/report')).toBe('https://example.org/report');
  expect(abuseHref('javascript:alert(1)')).toBeNull();
  expect(abuseHref('ftp://x')).toBeNull();
  expect(safeHttpUrl('http://example.org/terms')).toBe('http://example.org/terms');
  expect(safeHttpUrl('data:text/html,x')).toBeNull();

  // What is no address, or could make a mailto link do more than address one person.
  for (const contact of [
    '',
    'abuse',
    'abuse@example',
    'a@b@example.org',
    'abuse@example.org?cc=someone@else.org',
    'abuse@example.org, other@example.org',
    'javascript:alert(1)//@example.org',
    ' abuse@example.org',
  ]) {
    expect(abuseHref(contact), JSON.stringify(contact)).toBeNull();
  }
  expect(safeHttpUrl(undefined)).toBeNull();
  expect(safeHttpUrl('https://exa mple.org')).toBeNull();
  expect(safeHttpUrl('not a url')).toBeNull();
  expect(safeHttpUrl('//example.org')).toBeNull();
});

test('the sign-in page links the terms, the privacy notice and the abuse contact when set', async () => {
  renderRoute('/signin', { me: null, config: POLICY });

  const nav = await screen.findByRole('navigation', { name: t('web.policy.nav') }, TIMEOUT);
  const terms = within(nav).getByRole('link', { name: 'Terms of use' });
  expect(terms).toHaveAttribute('href', 'https://example.org/terms');
  expect(terms).toHaveAttribute('rel', 'noopener noreferrer');
  expect(terms).toHaveAttribute('target', '_blank');
  expect(within(nav).getByRole('link', { name: 'Privacy' })).toHaveAttribute(
    'href',
    'https://example.org/privacy',
  );
  expect(within(nav).getByText(t('pages.reportAbuse'), { exact: false })).toBeInTheDocument();
  expect(within(nav).getByRole('link', { name: 'abuse@example.org' })).toHaveAttribute(
    'href',
    'mailto:abuse@example.org',
  );
  cleanup();

  // Unset: nothing of it.
  renderRoute('/signin', { me: null });
  await screen.findByRole('heading', { level: 1, name: t('web.signin.title') }, TIMEOUT);
  expect(screen.queryByRole('navigation', { name: t('web.policy.nav') })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Terms of use' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument();
  expect(screen.queryByText(t('pages.reportAbuse'), { exact: false })).not.toBeInTheDocument();
});

test('a link that is no http(s) URL shows nowhere on the sign-in page', async () => {
  renderRoute('/signin', {
    me: null,
    config: { terms_url: 'javascript:alert(1)', privacy_url: 'ftp://example.org/p' },
  });
  await screen.findByRole('heading', { level: 1, name: t('web.signin.title') }, TIMEOUT);
  expect(screen.queryByRole('navigation', { name: t('web.policy.nav') })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Terms of use' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument();
});

/** Serves `GET /share/tok` with `info`, and nothing else the viewer needs for a link without comments. */
function serveViewer() {
  server.use(
    http.get(`${API}/share/tok`, () =>
      HttpResponse.json(fx.shareInfo({ artifact_name: 'Homepage' })),
    ),
  );
}

test('share pages show the abuse contact', async () => {
  // The viewer bar.
  serveViewer();
  renderRoute('/s/tok', { me: null, config: POLICY });
  await screen.findByRole('heading', { level: 1, name: 'Homepage' }, TIMEOUT);
  const flag = await screen.findByRole('link', { name: 'Report abuse' }, TIMEOUT);
  expect(flag).toHaveAttribute('href', 'mailto:abuse@example.org');
  expect(flag).toHaveAttribute('target', '_blank');
  expect(flag).toHaveAttribute('rel', 'noopener noreferrer');
  // It comes before Open original.
  const original = screen.getByRole('link', { name: 'Open original' });
  expect(flag.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  cleanup();

  // A link that is gone, and one that asks for a password: the abuse line only, never the terms.
  const cases = [
    () => apiError(410, 'gone', 'This share link was revoked.', { reason: 'revoked' }),
    () => apiError(401, 'unauthorized', 'Enter the password.', { password_required: true }),
  ];
  for (const answer of cases) {
    server.use(http.get(`${API}/share/tok`, answer));
    renderRoute('/s/tok', { me: null, config: POLICY });
    const mail = await screen.findByRole('link', { name: 'abuse@example.org' }, TIMEOUT);
    expect(mail).toHaveAttribute('href', 'mailto:abuse@example.org');
    expect(mail.closest('p')).toHaveTextContent('Report abuse: abuse@example.org');
    expect(screen.queryByRole('link', { name: 'Terms of use' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument();
    cleanup();
  }

  // Unset: no abuse line and no flag.
  server.use(
    http.get(`${API}/share/tok`, () => apiError(410, 'gone', 'This share link was revoked.')),
  );
  renderRoute('/s/tok', { me: null });
  await screen.findByRole('heading', { level: 1, name: t('share.gone.title') }, TIMEOUT);
  expect(screen.queryByText(t('pages.reportAbuse'), { exact: false })).not.toBeInTheDocument();
  cleanup();

  serveViewer();
  renderRoute('/s/tok', { me: null });
  await screen.findByRole('heading', { level: 1, name: 'Homepage' }, TIMEOUT);
  expect(screen.queryByRole('link', { name: 'Report abuse' })).not.toBeInTheDocument();
});

test('a contact that is no email or http(s) URL shows as text, never as a link', async () => {
  const config = { abuse_contact: 'javascript:alert(1)' };
  server.use(
    http.get(`${API}/share/tok`, () => apiError(410, 'gone', 'This share link was revoked.')),
  );
  renderRoute('/s/tok', { me: null, config });
  const text = await screen.findByText('javascript:alert(1)', {}, TIMEOUT);
  expect(text.closest('p')).toHaveTextContent('Report abuse: javascript:alert(1)');
  expect(text.closest('a')).toBeNull();
  expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  expect(screen.queryByRole('link', { name: /javascript/ })).not.toBeInTheDocument();
  cleanup();

  // The viewer bar has nothing to link to, so it shows no flag.
  serveViewer();
  renderRoute('/s/tok', { me: null, config });
  await screen.findByRole('heading', { level: 1, name: 'Homepage' }, TIMEOUT);
  expect(screen.queryByRole('link', { name: 'Report abuse' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="javascript"]')).toBeNull();
});
