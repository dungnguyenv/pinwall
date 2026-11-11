import { cleanup, screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import { fx } from '../test/fixtures.ts';
import { hoursAgo, serveSidebar } from '../test/library.ts';
import { renderRoute } from '../test/render.tsx';
import { API, apiError, server } from '../test/server.ts';

const me = fx.me({ id: 'usr_1' });
const launchSite = fx.project({ id: 'prj_2', name: 'Launch site' });
const pricing = fx.artifact({
  id: 'art_1',
  name: 'Pricing',
  project_id: 'prj_2',
  current_version: fx.version({ number: 3 }),
  updated_at: hoursAgo(2),
  share_link_count: 1,
});

function serveArtifactPage() {
  serveSidebar({ projects: [launchSite] });
  server.use(
    http.get(`${API}/artifacts/art_1`, () => HttpResponse.json(pricing)),
    http.get(`${API}/projects/prj_2`, () => HttpResponse.json(launchSite)),
  );
}

test('the artifact page shows the rail and a link to the raw page', async () => {
  serveArtifactPage();
  renderRoute('/a/art_1', { me });

  expect(await screen.findByRole('heading', { level: 1, name: 'Pricing' })).toBeInTheDocument();
  // The review screen keeps the sidebar folded to its rail.
  expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();

  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(await within(breadcrumb).findByRole('link', { name: 'Launch site' })).toHaveAttribute(
    'href',
    '/projects/prj_2',
  );
  expect(within(breadcrumb).getByText('Pricing')).toHaveAttribute('aria-current', 'page');
  expect(screen.getByText('Version 3 · updated 2 hours ago')).toBeInTheDocument();
  expect(screen.getByText('Shared')).toBeInTheDocument();
  const open = screen.getByRole('link', { name: 'Open page (opens in a new tab)' });
  expect(open).toHaveAttribute('href', '/a/art_1/raw');
  expect(open).toHaveAttribute('target', '_blank');
  cleanup();

  // A version link opens that version's page.
  serveArtifactPage();
  renderRoute('/a/art_1/v/2', { me });
  expect(await screen.findByText('Version 2 · updated 2 hours ago')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /^Open page/ })).toHaveAttribute(
    'href',
    '/a/art_1/v/2/raw',
  );
});

test('a deleted artifact shows the server message', async () => {
  serveSidebar();
  server.use(
    http.get(`${API}/artifacts/art_1`, () => apiError(410, 'gone', 'This artifact was deleted.')),
  );
  renderRoute('/a/art_1', { me });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Artifact not available' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('This artifact was deleted.');
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

test('a server failure offers Retry', async () => {
  serveSidebar();
  server.use(
    http.get(`${API}/artifacts/art_1`, () =>
      apiError(500, 'internal', 'Pinwall ran into an unexpected problem.'),
    ),
  );
  renderRoute('/a/art_1', { me });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Pinwall ran into an unexpected problem.');
  expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('unknown addresses and bad version numbers are not found', async () => {
  serveSidebar();
  renderRoute('/nowhere/at/all', { me });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Go to All artifacts' })).toHaveAttribute('href', '/');
  cleanup();

  serveSidebar();
  renderRoute('/a/art_1/v/0', { me });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
  ).toBeInTheDocument();
});
