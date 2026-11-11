import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import type { ArtifactSummary } from '../api/dto.ts';
import i18n from '../i18n.ts';
import { fx } from '../test/fixtures.ts';
import { artifactLink, hoursAgo, serveArtifacts, serveSidebar } from '../test/library.ts';
import { renderRoute } from '../test/render.tsx';
import { apiError } from '../test/server.ts';
import { ArtifactCard } from './artifact-card.tsx';

const me = fx.me({ id: 'usr_1' });
const launchSite = fx.project({ id: 'prj_2', name: 'Launch site' });

afterEach(() => localStorage.clear());

/** Renders artifact cards on their own page inside the app. */
function renderCards(artifacts: ArtifactSummary[]) {
  return renderRoute('/', {
    routes: [
      {
        path: '/',
        element: (
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <ArtifactCard artifact={artifact} />
              </li>
            ))}
          </ul>
        ),
      },
    ],
  });
}

function generatedCard(link: HTMLElement): HTMLElement | null {
  return link.querySelector('[data-thumb="generated"]');
}

test('cards show thumbnail or generated card, version, comments and sharing', async () => {
  renderCards([
    fx.artifact({
      id: 'art_1',
      name: 'Pricing',
      current_version: fx.version({ id: 'ver_1', number: 3, has_thumbnail: true }),
      updated_at: hoursAgo(2),
      open_thread_count: 2,
      share_link_count: 1,
    }),
    fx.artifact({ id: 'art_2', name: 'Security report', kind: 'markdown' }),
    fx.artifact({
      id: 'art_3',
      name: 'pricing-2027',
      current_version: fx.version({ title: 'Bảng giá 2027', theme_color: '#0ea5e9' }),
      open_thread_count: 0,
      share_link_count: 0,
    }),
  ]);

  const pricing = await screen.findByRole('link', { name: artifactLink('Pricing') });
  expect(pricing).toHaveAttribute('href', '/a/art_1');
  const image = pricing.querySelector('img');
  expect(image).toHaveAttribute('src', '/api/v1/artifacts/art_1/thumbnail?v=ver_1');
  expect(image).toHaveAttribute('alt', '');
  expect(image).toHaveAttribute('loading', 'lazy');
  expect(generatedCard(pricing)).toBeNull();
  expect(within(pricing).getByText('v3 · 2 hours ago')).toBeInTheDocument();
  expect(within(pricing).getByText('2 comments')).toBeInTheDocument();
  expect(within(pricing).getByText('Shared')).toBeInTheDocument();
  // Everything the card shows is in the link's name, the artifact's name first.
  expect(pricing).toHaveAccessibleName('Pricing v3 · 2 hours ago 2 comments Shared');

  const report = screen.getByRole('link', { name: artifactLink('Security report') });
  expect(report.querySelector('img')).toBeNull();
  expect(generatedCard(report)).toHaveTextContent('Security report');
  expect(generatedCard(report)).toHaveAttribute('aria-hidden', 'true');
  expect(within(report).queryByText(/comment/)).not.toBeInTheDocument();
  expect(within(report).queryByText('Shared')).not.toBeInTheDocument();

  // The page's own title and theme color make its card; zero counts show nothing.
  const priced = screen.getByRole('link', { name: artifactLink('pricing-2027') });
  expect(generatedCard(priced)).toHaveTextContent('Bảng giá 2027');
  expect(generatedCard(priced)?.style.backgroundColor).toMatch(/^rgb\(14,? 165,? 233\)$/);
  expect(within(priced).queryByText(/comment/)).not.toBeInTheDocument();
  expect(within(priced).queryByText('Shared')).not.toBeInTheDocument();
});

test('one open thread reads as one comment', async () => {
  renderCards([fx.artifact({ open_thread_count: 1 })]);
  const card = await screen.findByRole('link', { name: artifactLink('Homepage') });
  expect(within(card).getByText('1 comment')).toBeInTheDocument();
});

test('a thumbnail that fails to load falls back to the generated card', async () => {
  renderCards([
    fx.artifact({
      name: 'Landing',
      current_version: fx.version({ has_thumbnail: true }),
    }),
  ]);
  const card = await screen.findByRole('link', { name: artifactLink('Landing') });
  const image = card.querySelector('img');
  expect(image).not.toBeNull();
  fireEvent.error(image as HTMLImageElement);
  await waitFor(() => expect(card.querySelector('img')).toBeNull());
  expect(generatedCard(card)).toHaveTextContent('Landing');
});

test('long and markup-like names render as text', async () => {
  const name = `<img src=x onerror=alert(1)>${'x'.repeat(300)}`;
  renderCards([fx.artifact({ name })]);
  const card = await screen.findByRole('link', { name: artifactLink(name) });
  expect(within(card).getAllByText(name).length).toBeGreaterThan(0);
  expect(document.querySelector('img[src="x"]')).toBeNull();
  // The full name stays reachable when the card truncates it.
  expect(within(card).getByTitle(name)).toBeInTheDocument();
});

/** All artifacts with one artifact, and the view toggle's two options. */
function serveOneArtifact() {
  serveSidebar({ projects: [launchSite] });
  serveArtifacts(() =>
    HttpResponse.json(fx.page([fx.artifact({ name: 'Pricing', project_id: 'prj_2' })])),
  );
}

async function viewOption(name: 'Grid' | 'List') {
  const group = await screen.findByRole('radiogroup', { name: 'View' });
  return within(group).getByRole('radio', { name });
}

test('grid or list is remembered per user', async () => {
  serveOneArtifact();
  const { user } = renderRoute('/', { me });
  expect(await viewOption('Grid')).toHaveAttribute('aria-checked', 'true');
  await screen.findByRole('link', { name: artifactLink('Pricing') });

  await user.click(await viewOption('List'));
  expect(await viewOption('List')).toHaveAttribute('aria-checked', 'true');
  expect(localStorage.getItem('pinwall:library-view:usr_1')).toBe('list');
  // Rows name the project, since All artifacts mixes them.
  expect(await screen.findByRole('link', { name: artifactLink('Pricing') })).toHaveAccessibleName(
    /^Pricing Launch site · v1 · /,
  );
  cleanup();

  serveOneArtifact();
  renderRoute('/', { me });
  expect(await viewOption('List')).toHaveAttribute('aria-checked', 'true');
  cleanup();

  serveOneArtifact();
  renderRoute('/', { me: fx.me({ id: 'usr_2' }) });
  expect(await viewOption('Grid')).toHaveAttribute('aria-checked', 'true');
});

test('view toggle survives a throwing localStorage', async () => {
  const blocked = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
  onTestFinished(() => {
    getItem.mockRestore();
    setItem.mockRestore();
  });

  serveOneArtifact();
  const { user } = renderRoute('/', { me });
  expect(await viewOption('Grid')).toHaveAttribute('aria-checked', 'true');
  expect(await screen.findByRole('link', { name: artifactLink('Pricing') })).toBeInTheDocument();
  await user.click(await viewOption('List'));
  expect(await viewOption('List')).toHaveAttribute('aria-checked', 'true');
  expect(await screen.findByRole('link', { name: artifactLink('Pricing') })).toHaveAccessibleName(
    /^Pricing Launch site · /,
  );
});

test('collections have skeleton, empty and error states and load more', async () => {
  // Loading: skeletons under one polite status, until the page arrives.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  serveSidebar();
  serveArtifacts(async () => {
    await released;
    return HttpResponse.json(fx.page([fx.artifact({ name: 'Pricing' })]));
  });
  renderRoute('/', { me });
  expect(
    await screen.findByRole('status', { name: i18n.t('web.library.loading') }),
  ).toBeInTheDocument();
  release();
  expect(await screen.findByRole('link', { name: artifactLink('Pricing') })).toBeInTheDocument();
  expect(
    screen.queryByRole('status', { name: i18n.t('web.library.loading') }),
  ).not.toBeInTheDocument();
  cleanup();

  // Empty.
  serveSidebar();
  serveArtifacts(() => HttpResponse.json(fx.page([])));
  renderRoute('/', { me });
  expect(await screen.findByText(i18n.t('web.library.emptyTitle'))).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute(
    'href',
    '/connect',
  );
  cleanup();

  // An error, with Retry.
  serveSidebar();
  let failures = 0;
  serveArtifacts(() => {
    failures += 1;
    return apiError(500, 'internal', 'Pinwall ran into an unexpected problem.');
  });
  const failing = renderRoute('/', { me });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Pinwall ran into an unexpected problem.');
  await failing.user.click(within(alert).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(failures).toBe(2));
  cleanup();

  // More pages: "Load more" asks for the next cursor and adds its items.
  serveSidebar();
  const requests = serveArtifacts((params) =>
    HttpResponse.json(
      params.get('cursor') === 'c2'
        ? fx.page([fx.artifact({ id: 'art_2', name: 'Second page' })])
        : fx.page([fx.artifact({ id: 'art_1', name: 'First page' })], 'c2'),
    ),
  );
  const { user } = renderRoute('/', { me });
  await screen.findByRole('link', { name: artifactLink('First page') });
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(
    await screen.findByRole('link', { name: artifactLink('Second page') }),
  ).toBeInTheDocument();
  expect(screen.getByRole('link', { name: artifactLink('First page') })).toBeInTheDocument();
  expect(requests).toEqual(['?limit=48', '?cursor=c2&limit=48']);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'All artifacts' });
  expect(
    within(list)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toHaveLength(2);
});
