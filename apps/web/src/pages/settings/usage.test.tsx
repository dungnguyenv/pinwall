import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import type { Me } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { fakeDrop, file } from '../../test/fake-entries.ts';
import { fx } from '../../test/fixtures.ts';
import { serveArtifacts, serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { PERSONAL } from '../../test/spaces.ts';

const t = i18n.t.bind(i18n);

beforeEach(() => serveSidebar());

const USAGE = { bytes: 120_000_000, artifacts: 12 };
const LIMITS = { bytes: 500_000_000, artifacts: 200 };

/** The signed-in person with `usage` and `limits` as the server sends them; each can be replaced. */
function withUsage(o: Partial<Pick<Me, 'usage' | 'limits' | 'email'>> = {}): Me {
  return fx.me({ usage: USAGE, limits: LIMITS, ...o });
}

const settingsNav = () => screen.getByRole('navigation', { name: 'Settings sections' });
const storageMeter = () => screen.getByRole('meter', { name: t('web.usage.storage') });
const artifactsMeter = () => screen.getByRole('meter', { name: t('web.usage.artifacts') });

test('usage shows bytes and artifacts against the limits', async () => {
  renderRoute('/settings/usage', { me: withUsage() });

  expect(await screen.findByText('120 MB of 500 MB')).toBeInTheDocument();
  expect(screen.getByText('12 of 200 artifacts')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: 'Usage' })).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe('Usage · Pinwall'));

  expect(storageMeter()).toHaveAttribute('aria-valuenow', '120000000');
  expect(storageMeter()).toHaveAttribute('aria-valuemax', '500000000');
  expect(storageMeter()).toHaveAttribute('aria-valuetext', '120 MB of 500 MB');
  expect(artifactsMeter()).toHaveAttribute('aria-valuenow', '12');
  expect(artifactsMeter()).toHaveAttribute('aria-valuemax', '200');
  expect(artifactsMeter()).toHaveAttribute('aria-valuetext', '12 of 200 artifacts');
  expect(screen.getByText(t('web.usage.counting'))).toBeInTheDocument();
  expect(screen.queryByText(t('web.usage.full'))).not.toBeInTheDocument();
  expect(storageMeter()).toHaveAttribute('data-tone', 'normal');
});

test('a null limit reads as no limit, as plain figures with no meter', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ limits: { bytes: null, artifacts: null } }),
  });

  expect(await screen.findByText('120 MB used (no limit)')).toBeInTheDocument();
  expect(screen.getByText('12 artifacts (no limit)')).toBeInTheDocument();
  expect(screen.getByText(t('web.usage.storage'))).toBeInTheDocument();
  expect(screen.getByText(t('web.usage.artifacts'))).toBeInTheDocument();
  // With nothing to measure against there is no meter, so no value out of a range that is not there.
  expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  expect(document.querySelector('[aria-valuenow]')).toBeNull();
  expect(screen.queryByText(t('web.usage.full'))).not.toBeInTheDocument();
});

const filesMeter = () => screen.getByRole('meter', { name: t('web.usage.files') });

test('a files limit adds a meter of its own', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ usage: { ...USAGE, files: 46_000 }, limits: { ...LIMITS, files: 50_000 } }),
  });

  expect(await screen.findByText('46000 of 50000 files')).toBeInTheDocument();
  expect(filesMeter()).toHaveAttribute('aria-valuenow', '46000');
  expect(filesMeter()).toHaveAttribute('aria-valuemax', '50000');
  expect(filesMeter()).toHaveAttribute('data-tone', 'warning');
  expect(screen.queryByText(t('web.usage.full'))).not.toBeInTheDocument();
});

test('a space at its files limit is full', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ usage: { ...USAGE, files: 50_000 }, limits: { ...LIMITS, files: 50_000 } }),
  });

  expect(await screen.findByText(t('web.usage.full'))).toBeInTheDocument();
  expect(filesMeter()).toHaveAttribute('data-tone', 'danger');
  expect(storageMeter()).toHaveAttribute('data-tone', 'normal');
});

test('without a files limit the files are not shown', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ usage: { ...USAGE, files: 30 }, limits: { ...LIMITS, files: null } }),
  });

  expect(await screen.findByText('120 MB of 500 MB')).toBeInTheDocument();
  expect(screen.queryByText(t('web.usage.files'))).not.toBeInTheDocument();
  expect(screen.getAllByRole('meter')).toHaveLength(2);
});

test('one limit set and the other not: a meter for the one, figures for the other', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({
      usage: { bytes: 120_000_000, artifacts: 1 },
      limits: { bytes: 500_000_000, artifacts: null },
    }),
  });

  expect(await screen.findByText('1 artifact (no limit)')).toBeInTheDocument();
  expect(storageMeter()).toHaveAttribute('aria-valuetext', '120 MB of 500 MB');
  expect(storageMeter()).toHaveAttribute('aria-valuemax', '500000000');
  expect(screen.getAllByRole('meter')).toHaveLength(1);
});

test('a meter turns to a warning from 90 percent', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ usage: { bytes: 449_000_000, artifacts: 180 } }),
  });

  expect(await screen.findByText('449 MB of 500 MB')).toBeInTheDocument();
  // 89.8 percent of the bytes: not yet; exactly 90 percent of the artifacts: warned.
  expect(storageMeter()).toHaveAttribute('data-tone', 'normal');
  expect(artifactsMeter()).toHaveAttribute('data-tone', 'warning');
  expect(screen.queryByText(t('web.usage.full'))).not.toBeInTheDocument();
});

test('a full space says what to do', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ usage: { bytes: 500_000_000, artifacts: 12 } }),
  });

  expect(await screen.findByText('500 MB of 500 MB')).toBeInTheDocument();
  expect(screen.getByText(t('web.usage.full'))).toBeInTheDocument();
  expect(storageMeter()).toHaveAttribute('data-tone', 'danger');
  expect(artifactsMeter()).toHaveAttribute('data-tone', 'normal');
});

test('over the limit reads as full too, and the bar stops at the end', async () => {
  renderRoute('/settings/usage', {
    me: withUsage({ usage: { bytes: 12, artifacts: 201 } }),
  });

  expect(await screen.findByText('201 of 200 artifacts')).toBeInTheDocument();
  expect(screen.getByText(t('web.usage.full'))).toBeInTheDocument();
  expect(artifactsMeter()).toHaveAttribute('data-tone', 'danger');
  // The value never passes the maximum; the value text carries the overshoot.
  expect(artifactsMeter()).toHaveAttribute('aria-valuenow', '200');
  expect(artifactsMeter()).toHaveAttribute('aria-valuetext', '201 of 200 artifacts');
});

test('the page reads the usage afresh when it opens', async () => {
  let reads = 0;
  server.use(
    http.get(`${API}/me`, () => {
      reads += 1;
      return HttpResponse.json(
        withUsage({ usage: { bytes: reads === 1 ? 100_000_000 : 120_000_000, artifacts: 12 } }),
      );
    }),
  );
  renderRoute('/settings/usage');

  expect(await screen.findByText('120 MB of 500 MB')).toBeInTheDocument();
  expect(reads).toBe(2);
});

test('the Usage page exists only when the server sends usage', async () => {
  renderRoute('/settings/profile', { me: fx.me() });
  await screen.findByRole('textbox', { name: 'Name' });
  expect(within(settingsNav()).queryByRole('link', { name: 'Usage' })).not.toBeInTheDocument();
});

test('without usage the Usage address goes to the profile', async () => {
  const { router } = renderRoute('/settings/usage', { me: fx.me() });

  expect(await screen.findByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/settings/profile');
  expect(screen.queryByRole('meter')).not.toBeInTheDocument();
});

test('with usage the settings list has a Usage link that opens the page', async () => {
  const { user, router } = renderRoute('/settings/profile', { me: withUsage() });
  await screen.findByRole('textbox', { name: 'Name' });

  const links = within(settingsNav()).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual([
    'Profile',
    'Security',
    'API tokens',
    'Usage',
  ]);
  await user.click(within(settingsNav()).getByRole('link', { name: 'Usage' }));
  expect(await screen.findByRole('meter', { name: 'Storage' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/settings/usage');
  expect(within(settingsNav()).getByRole('link', { name: 'Usage' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

/** Serves the purge route, recording each body; `respond` decides the answer. */
function servePurge(
  respond: () => Response = () => HttpResponse.json({ projects: 2, artifacts: 5 }),
) {
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API}/me/purge`, async ({ request }) => {
      bodies.push(await request.json());
      return respond();
    }),
  );
  serveArtifacts(() => HttpResponse.json(fx.page([])));
  return bodies;
}

const openPurge = async (user: ReturnType<typeof renderRoute>['user']) => {
  await user.click(await screen.findByRole('button', { name: t('web.purge.self.title') }));
  return screen.findByRole('alertdialog', { name: t('web.purge.self.title') });
};

test('Delete all my content needs the email typed, then deletes and goes home', async () => {
  const bodies = servePurge();
  const { user, router } = renderRoute('/settings/usage', { me: withUsage(), config: PERSONAL });

  expect(await screen.findByText(t('web.purge.self.body'))).toBeInTheDocument();
  const dialog = await openPurge(user);
  const confirm = within(dialog).getByRole('button', { name: t('web.purge.button') });
  expect(confirm).toBeDisabled();

  await user.type(
    within(dialog).getByRole('textbox', {
      name: t('web.purge.type', { value: 'ada@example.com' }),
    }),
    ' ADA@example.com ',
  );
  expect(confirm).toBeEnabled();
  await user.click(confirm);

  expect(await screen.findByText('Deleted 2 projects and 5 artifacts.')).toBeInTheDocument();
  expect(bodies).toEqual([{ confirm_email: 'ADA@example.com' }]);
  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('one project and one artifact read in the singular', async () => {
  servePurge(() => HttpResponse.json({ projects: 1, artifacts: 1 }));
  const { user } = renderRoute('/settings/usage', { me: withUsage(), config: PERSONAL });

  const dialog = await openPurge(user);
  await user.type(within(dialog).getByRole('textbox'), 'ada@example.com');
  await user.click(within(dialog).getByRole('button', { name: t('web.purge.button') }));

  expect(await screen.findByText('Deleted 1 project and 1 artifact.')).toBeInTheDocument();
});

test('an account without an email confirms with its id', async () => {
  const bodies = servePurge();
  const me = withUsage({ email: null });
  const { user } = renderRoute('/settings/usage', { me, config: PERSONAL });

  const dialog = await openPurge(user);
  const confirm = within(dialog).getByRole('button', { name: t('web.purge.button') });
  const field = within(dialog).getByRole('textbox', {
    name: t('web.purge.type', { value: me.id }),
  });
  await user.type(field, 'ada@example.com');
  expect(confirm).toBeDisabled();

  await user.clear(field);
  await user.type(field, me.id);
  expect(confirm).toBeEnabled();
  await user.click(confirm);

  await waitFor(() => expect(bodies).toEqual([{ confirm_email: me.id }]));
});

test.each([
  [400, 'bad_request', 'purge.confirm'],
  [409, 'conflict', 'purge.busy'],
])("the server's %i refusal stays in the dialog", async (status, code, key) => {
  servePurge(() => apiError(status, code, t(key)));
  const { user, router } = renderRoute('/settings/usage', { me: withUsage(), config: PERSONAL });

  const dialog = await openPurge(user);
  await user.type(within(dialog).getByRole('textbox'), 'ada@example.com');
  await user.click(within(dialog).getByRole('button', { name: t('web.purge.button') }));

  expect(await within(dialog).findByText(t(key))).toBeInTheDocument();
  expect(screen.getByRole('alertdialog', { name: t('web.purge.self.title') })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/settings/usage');
  // The person can correct the text and try again.
  expect(within(dialog).getByRole('button', { name: t('web.purge.button') })).toBeEnabled();
});

test('Delete all my content is not offered in team mode', async () => {
  renderRoute('/settings/usage', { me: withUsage() });

  expect(await screen.findByText('120 MB of 500 MB')).toBeInTheDocument();
  expect(screen.getByRole('meter', { name: 'Storage' })).toBeInTheDocument();
  expect(screen.queryByText(t('web.purge.self.title'))).not.toBeInTheDocument();
  expect(screen.queryByText(t('web.purge.self.body'))).not.toBeInTheDocument();
});

test("a publish over the quota shows the server's words in the upload toast", async () => {
  const message = t('quota.bytes.own', { needed: '2 MB', used: '499 MB', limit: '500 MB' });
  serveArtifacts(() => HttpResponse.json(fx.page([])));
  server.use(http.post(`${API}/publish/upload`, () => apiError(413, 'quota_exceeded', message)));
  renderRoute('/', { me: withUsage(), config: PERSONAL });
  await screen.findByRole('heading', { level: 1, name: t('web.library.allTitle') });

  const dt = fakeDrop([file('index.html')]);
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  fireEvent.dragOver(document.body, { dataTransfer: dt });
  fireEvent.drop(document.body, { dataTransfer: dt });

  const text = await screen.findByText(message);
  expect(text.closest('[data-sonner-toast]')).not.toBeNull();
});
