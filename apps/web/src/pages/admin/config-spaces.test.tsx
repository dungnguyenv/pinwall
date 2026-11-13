import { screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import i18n from '../../i18n.ts';
import { fxAdminConfig, fxConfigEntry, serveAdminConfig } from '../../test/admin.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';

const t = i18n.t.bind(i18n);

beforeEach(() => serveSidebar());

/** The row of one environment variable: its name, value and help. */
async function rowOf(env: string): Promise<HTMLElement> {
  // The explainer names the same variables, so look at the row's term.
  const name = await screen.findByText(env, { selector: 'dt code' });
  const row = name.closest('div');
  if (!row) throw new Error(`no row for ${env}`);
  return row;
}

const SPACES = [
  fxConfigEntry({ section: 'spaces', env: 'PINWALL_VISIBILITY', value: 'team' }),
  fxConfigEntry({ section: 'spaces', env: 'PINWALL_SHARE_LINKS', value: 'members' }),
];

const withEntries = (...entries: ReturnType<typeof fxConfigEntry>[]) =>
  fxAdminConfig({ entries: [...fxAdminConfig().entries, ...entries] });

/** The explainer item that says `text`, as a list item. */
function itemSaying(scope: ReturnType<typeof within>, text: string): HTMLElement {
  const item = scope.getByText(text).closest('li');
  if (!item) throw new Error(`no item says ${text}`);
  return item;
}

test('configuration explains visibility and sharing, and marks the current ones', async () => {
  serveAdminConfig(
    withEntries(
      fxConfigEntry({ section: 'spaces', env: 'PINWALL_VISIBILITY', value: 'personal' }),
      fxConfigEntry({ section: 'spaces', env: 'PINWALL_SHARE_LINKS', value: 'approved' }),
    ),
  );
  renderRoute('/admin/config');

  const region = within(
    await screen.findByRole('region', { name: 'Who sees what, and who may share' }),
  );
  expect(t('web.config.spaces.title')).toBe('Who sees what, and who may share');
  const team = itemSaying(region, 'team: every member sees every project, as in Pinwall 1.0.');
  const personal = itemSaying(
    region,
    "personal: each person sees only the projects they own or were added to. Admins do not see other people's work.",
  );
  const members = itemSaying(region, 'members: anyone may make share links and open raw links.');
  const approved = itemSaying(
    region,
    "approved: only admins and people approved in Users may; everyone else's pages open only inside Pinwall's viewer.",
  );

  // Only the values in force say Current.
  expect(within(personal).getByText('Current')).toBeInTheDocument();
  expect(within(approved).getByText('Current')).toBeInTheDocument();
  expect(within(team).queryByText('Current')).not.toBeInTheDocument();
  expect(within(members).queryByText('Current')).not.toBeInTheDocument();
  expect(region.getAllByText('Current')).toHaveLength(2);

  // It sits after the isolation explainer, before the sections.
  const main = screen.getByRole('main');
  const headings = within(main)
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);
  expect(headings.slice(0, 2)).toEqual([
    'How artifacts are kept apart',
    'Who sees what, and who may share',
  ]);
});

test('the team and members values are marked when they are the current ones', async () => {
  serveAdminConfig(withEntries(...SPACES));
  renderRoute('/admin/config');

  const region = within(
    await screen.findByRole('region', { name: 'Who sees what, and who may share' }),
  );
  expect(
    within(
      itemSaying(region, 'team: every member sees every project, as in Pinwall 1.0.'),
    ).getByText('Current'),
  ).toBeInTheDocument();
  expect(
    within(
      itemSaying(region, 'members: anyone may make share links and open raw links.'),
    ).getByText('Current'),
  ).toBeInTheDocument();
  expect(region.getAllByText('Current')).toHaveLength(2);
});

test('without the new settings the page is the 1.0 page', async () => {
  serveAdminConfig(fxAdminConfig());
  renderRoute('/admin/config');
  expect(await screen.findByText(t('web.config.envNote'))).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'How artifacts are kept apart' })).toBeInTheDocument();
  expect(
    screen.queryByRole('region', { name: 'Who sees what, and who may share' }),
  ).not.toBeInTheDocument();
});

test('a quota of 0 reads as no limit', async () => {
  serveAdminConfig(
    withEntries(
      fxConfigEntry({ section: 'limits', env: 'PINWALL_QUOTA_BYTES', value: '0' }),
      fxConfigEntry({ section: 'limits', env: 'PINWALL_QUOTA_ARTIFACTS', value: '0' }),
    ),
  );
  renderRoute('/admin/config');

  for (const env of ['PINWALL_QUOTA_BYTES', 'PINWALL_QUOTA_ARTIFACTS']) {
    const row = await rowOf(env);
    expect(within(row).getByText('0 (no limit)')).toBeInTheDocument();
    expect(within(row).queryByText(/≈/)).not.toBeInTheDocument();
  }
  expect(t('web.config.noLimit')).toBe('0 (no limit)');
});

test('a quota above 0 shows its value, with the size for bytes', async () => {
  serveAdminConfig(
    withEntries(
      fxConfigEntry({ section: 'limits', env: 'PINWALL_QUOTA_BYTES', value: '1000000000' }),
      fxConfigEntry({ section: 'limits', env: 'PINWALL_QUOTA_ARTIFACTS', value: '50' }),
    ),
  );
  renderRoute('/admin/config');

  const bytes = await rowOf('PINWALL_QUOTA_BYTES');
  expect(within(bytes).getByText('1000000000')).toBeInTheDocument();
  expect(within(bytes).getByText('≈ 1 GB')).toBeInTheDocument();
  const artifacts = await rowOf('PINWALL_QUOTA_ARTIFACTS');
  expect(within(artifacts).getByText('50')).toBeInTheDocument();
  expect(within(artifacts).queryByText(/\(no limit\)/)).not.toBeInTheDocument();
});

test('every new setting has its help line', async () => {
  const VALUES: Record<string, string> = {
    PINWALL_SHARE_LINKS: 'members',
    PINWALL_QUOTA_BYTES: '10',
    PINWALL_QUOTA_ARTIFACTS: '10',
    PINWALL_ABUSE_CONTACT: 'abuse@example.test',
    PINWALL_TERMS_URL: 'https://example.test/terms',
    PINWALL_PRIVACY_URL: 'https://example.test/privacy',
  };
  const envs = [
    'PINWALL_VISIBILITY',
    'PINWALL_SHARE_LINKS',
    'PINWALL_QUOTA_BYTES',
    'PINWALL_QUOTA_ARTIFACTS',
    'PINWALL_ABUSE_CONTACT',
    'PINWALL_TERMS_URL',
    'PINWALL_PRIVACY_URL',
  ];
  serveAdminConfig(
    withEntries(
      ...envs.map((env) =>
        fxConfigEntry({
          section: env.includes('QUOTA') ? 'limits' : 'spaces',
          env,
          value: VALUES[env] ?? 'team',
        }),
      ),
    ),
  );
  renderRoute('/admin/config');

  for (const env of envs) {
    const key = `web.config.help.${env}`;
    expect(i18n.exists(key), key).toBe(true);
    expect(within(await rowOf(env)).getByText(t(key))).toBeInTheDocument();
  }
});
