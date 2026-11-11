import { screen, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import i18n from '../../i18n.ts';
import { fxAdminConfig, fxConfigEntry, serveAdminConfig } from '../../test/admin.ts';
import { fx } from '../../test/fixtures.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';

const t = i18n.t;

beforeEach(() => serveSidebar());

/** The row of one environment variable: its name, value and help. */
async function rowOf(env: string): Promise<HTMLElement> {
  const name = await screen.findByText(env);
  const row = name.closest('div');
  if (!row) throw new Error(`no row for ${env}`);
  return row;
}

test('configuration shows sections, values, hidden secrets and help', async () => {
  const config = fxAdminConfig();
  serveAdminConfig(config);
  renderRoute('/admin/config');

  expect(await screen.findByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
  expect(document.title).toBe('Configuration · Pinwall');
  expect(await screen.findByText(t('web.config.envNote'))).toBeInTheDocument();
  expect(t('web.config.envNote')).toBe(
    'These settings come from environment variables. Pinwall shows them but never changes them: edit your deployment and restart.',
  );

  // One section per group the server sent, in its order, each a list of terms.
  const headings = within(screen.getByRole('main'))
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent)
    .filter((text) => text !== t('web.isolation.title'));
  expect(headings).toEqual([
    'General',
    'Content isolation',
    'Storage',
    'Single sign-on',
    'Upload limits',
    'Lifetimes',
  ]);

  // A plain value is shown as it would be written in the environment.
  const port = await rowOf('PINWALL_PORT');
  expect(within(port).getByText('8080').tagName).toBe('CODE');
  expect(within(port).getByText('PINWALL_PORT').tagName).toBe('CODE');

  // A secret that is set is hidden; an unset value says so.
  const secret = await rowOf('PINWALL_S3_SECRET_ACCESS_KEY');
  expect(within(secret).getByText('Set (hidden)')).toBeInTheDocument();
  expect(within(await rowOf('PINWALL_OIDC_ISSUER')).getByText('Not set')).toBeInTheDocument();

  // A byte limit also reads in plain units.
  const upload = await rowOf('PINWALL_MAX_UPLOAD_BYTES');
  expect(within(upload).getByText('95000000')).toBeInTheDocument();
  expect(within(upload).getByText('≈ 95 MB')).toBeInTheDocument();
  expect(within(await rowOf('PINWALL_MAX_EXPANSION_RATIO')).queryByText(/≈/)).toBeNull();

  // Every entry explains itself in one line.
  for (const entry of config.entries) {
    const key = `web.config.help.${entry.env}`;
    expect(i18n.exists(key), key).toBe(true);
    expect(within(await rowOf(entry.env)).getByText(t(key))).toBeInTheDocument();
  }
});

test('an unset secret says it is not set', async () => {
  serveAdminConfig(
    fxAdminConfig({
      entries: [
        fxConfigEntry({
          section: 'sign_in',
          env: 'PINWALL_OIDC_CLIENT_SECRET',
          secret: true,
          set: false,
        }),
      ],
    }),
  );
  renderRoute('/admin/config');
  const row = await rowOf('PINWALL_OIDC_CLIENT_SECRET');
  expect(within(row).getByText('Not set')).toBeInTheDocument();
  expect(within(row).queryByText('Set (hidden)')).not.toBeInTheDocument();
});

test('the generated secret key and the http issuer switch explain themselves', async () => {
  serveAdminConfig(
    fxAdminConfig({
      entries: [
        fxConfigEntry({ env: 'PINWALL_SECRET_KEY', secret: true, set: true }),
        fxConfigEntry({
          section: 'sign_in',
          env: 'PINWALL_OIDC_ALLOW_HTTP_ISSUER',
          value: 'false',
        }),
      ],
    }),
  );
  renderRoute('/admin/config');
  // It always shows as set, because Pinwall makes one when none is given.
  expect(
    within(await rowOf('PINWALL_SECRET_KEY')).getByText(/generates it into the data folder/),
  ).toBeInTheDocument();
  expect(
    within(await rowOf('PINWALL_OIDC_ALLOW_HTTP_ISSUER')).getByText(
      t('web.config.help.PINWALL_OIDC_ALLOW_HTTP_ISSUER'),
    ),
  ).toBeInTheDocument();
});

test('configuration explains both isolation modes and marks the current one', async () => {
  serveAdminConfig(fxAdminConfig({ isolation: 'single-domain' }));
  renderRoute('/admin/config');

  const explainer = within(await screen.findByRole('region', { name: t('web.isolation.title') }));
  const modes = explainer.getAllByRole('listitem');
  expect(modes).toHaveLength(2);
  expect(within(modes[0] as HTMLElement).getByText('Single domain')).toBeInTheDocument();
  expect(within(modes[0] as HTMLElement).getByText('Current')).toBeInTheDocument();
  expect(within(modes[1] as HTMLElement).getByText('Separate content domain')).toBeInTheDocument();
  expect(within(modes[1] as HTMLElement).queryByText('Current')).not.toBeInTheDocument();
  expect(explainer.getByText(t('web.isolation.tradeoff'))).toBeInTheDocument();
  // No content origin in single-domain mode.
  expect(screen.queryByText(t('web.config.contentOrigin'))).not.toBeInTheDocument();
});

test('content-domain mode names its content origin', async () => {
  serveAdminConfig(
    fxAdminConfig({
      isolation: 'content-domain',
      content_origin: 'https://pinwall-content.example',
      entries: [
        fxConfigEntry({ section: 'isolation', env: 'PINWALL_ISOLATION', value: 'content-domain' }),
        fxConfigEntry({
          section: 'isolation',
          env: 'PINWALL_CONTENT_ORIGIN',
          value: 'https://pinwall-content.example',
        }),
      ],
    }),
  );
  renderRoute('/admin/config');

  const explainer = within(await screen.findByRole('region', { name: t('web.isolation.title') }));
  const modes = explainer.getAllByRole('listitem');
  expect(within(modes[1] as HTMLElement).getByText('Current')).toBeInTheDocument();
  expect(within(modes[0] as HTMLElement).queryByText('Current')).not.toBeInTheDocument();

  const origin = screen.getByText(t('web.config.contentOrigin')).closest('p, div') as HTMLElement;
  expect(within(origin).getByText('https://pinwall-content.example')).toBeInTheDocument();
});

test('warnings appear as callouts above the settings', async () => {
  serveAdminConfig(
    fxAdminConfig({
      warnings: [
        'PINWALL_CONTENT_ORIGIN shares a registrable domain with PINWALL_PUBLIC_ORIGIN.',
        'PINWALL_OIDC_ISSUER (http://idp.internal) uses http:.',
      ],
    }),
  );
  renderRoute('/admin/config');

  const warnings = within(await screen.findByRole('list', { name: 'Warnings' }));
  expect(warnings.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'PINWALL_CONTENT_ORIGIN shares a registrable domain with PINWALL_PUBLIC_ORIGIN.',
    'PINWALL_OIDC_ISSUER (http://idp.internal) uses http:.',
  ]);
});

test('no warnings, no warnings list', async () => {
  serveAdminConfig(fxAdminConfig({ warnings: [] }));
  renderRoute('/admin/config');
  await rowOf('PINWALL_PORT');
  expect(screen.queryByRole('list', { name: 'Warnings' })).not.toBeInTheDocument();
});

test('admin lists have loading and error states', async () => {
  let fail = true;
  server.use(
    http.get(`${API}/admin/config`, async () => {
      await delay(40);
      return fail
        ? apiError(500, 'internal', 'The configuration is unavailable.')
        : HttpResponse.json(fxAdminConfig());
    }),
  );
  const { user } = renderRoute('/admin/config');

  expect(await screen.findByRole('status', { name: 'Loading configuration' })).toBeInTheDocument();
  expect(await screen.findByText('The configuration is unavailable.')).toBeInTheDocument();

  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await rowOf('PINWALL_PORT')).toBeInTheDocument();
});

test('members are told the configuration is for admins and nothing is fetched', async () => {
  let fetched = 0;
  server.use(
    http.get(`${API}/admin/config`, () => {
      fetched += 1;
      return HttpResponse.json(fxAdminConfig());
    }),
  );
  renderRoute('/admin/config', { me: fx.me({ role: 'member' }) });
  expect(await screen.findByText(t('auth.adminOnly'))).toBeInTheDocument();
  await delay(30);
  expect(fetched).toBe(0);
});
