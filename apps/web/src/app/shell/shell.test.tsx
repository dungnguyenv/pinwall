import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { lazy } from 'react';
import { afterEach, expect, test } from 'vitest';
import type { Project } from '../../api/dto.ts';
import type { LibraryArtifact } from '../../api/library.ts';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { RequireAuth } from '../require-auth.tsx';
import { AppShell } from './app-shell.tsx';
import { PageHeader } from './page-header.tsx';

const me = fx.me({ id: 'usr_1', name: 'Ada Lovelace', role: 'admin' });
const defaultProject = fx.project({ id: 'prj_1', name: 'Default', is_default: true });
const launchSite = fx.project({ id: 'prj_2', name: 'Launch site' });
const oldSite = fx.project({ id: 'prj_9', name: 'Old site', archived_at: Date.UTC(2026, 9, 1) });
const recentArtifacts = [
  fx.artifact({ id: 'art_1', name: 'Pricing page', project_id: 'prj_2' }),
  fx.artifact({ id: 'art_2', name: 'Security report', kind: 'markdown' }),
];

afterEach(() => localStorage.clear());

/** Serves the sidebar's lists. Returns the requests each list received. */
function serveLibrary(
  o: { projects?: Project[]; archived?: Project[]; recent?: LibraryArtifact[] } = {},
) {
  const seen = { projects: 0, archived: 0, recent: 0 };
  server.use(
    http.get(`${API}/projects`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const archived = params.get('archived') === 'true';
      if (archived) seen.archived += 1;
      else seen.projects += 1;
      expect(params.get('limit')).toBe('200');
      return HttpResponse.json(
        fx.page(
          archived ? (o.archived ?? [oldSite]) : (o.projects ?? [defaultProject, launchSite]),
        ),
      );
    }),
    http.get(`${API}/artifacts/recent`, ({ request }) => {
      seen.recent += 1;
      expect(new URL(request.url).searchParams.get('limit')).toBe('8');
      return HttpResponse.json(fx.page(o.recent ?? recentArtifacts));
    }),
  );
  return seen;
}

function sidebar() {
  return screen.getByRole('navigation', { name: 'Main' });
}

function linkNames(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');
}

test('shows projects, recent artifacts and the account', async () => {
  // The server's order is not trusted: the default project always leads.
  serveLibrary({ projects: [launchSite, defaultProject] });
  renderRoute('/projects/prj_2', { me });

  const projects = await screen.findByRole('list', { name: 'Projects' });
  await waitFor(() => expect(linkNames(projects)).toEqual(['Default', 'Launch site']));
  expect(within(projects).getByRole('link', { name: 'Launch site' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(within(projects).getByRole('link', { name: 'Default' })).not.toHaveAttribute(
    'aria-current',
  );
  expect(within(projects).getByRole('link', { name: 'Launch site' })).toHaveAttribute(
    'href',
    '/projects/prj_2',
  );

  const recent = await screen.findByRole('list', { name: 'Recent' });
  await waitFor(() => expect(linkNames(recent)).toEqual(['Pricing page', 'Security report']));
  expect(within(recent).getByRole('link', { name: 'Pricing page' })).toHaveAttribute(
    'href',
    '/a/art_1',
  );

  const nav = sidebar();
  expect(within(nav).getByRole('link', { name: 'All artifacts' })).toHaveAttribute('href', '/');
  expect(within(nav).getByRole('link', { name: 'All artifacts' })).not.toHaveAttribute(
    'aria-current',
  );
  expect(within(nav).getByRole('button', { name: 'New project' })).toBeInTheDocument();
  expect(within(nav).getByRole('button', { name: 'Search' })).toHaveAttribute(
    'aria-keyshortcuts',
    'Control+K',
  );
  expect(within(nav).getByRole('button', { name: 'Ada Lovelace' })).toHaveAttribute(
    'aria-haspopup',
    'menu',
  );
});

test('sidebar lists have loading, empty and error states', async () => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  serveLibrary({ recent: [] });
  server.use(
    http.get(`${API}/projects`, async () => {
      await released;
      return HttpResponse.json(fx.page([defaultProject]));
    }),
  );
  renderRoute('/', { me });
  expect(await screen.findByRole('status', { name: 'Loading projects' })).toBeInTheDocument();
  expect(await screen.findByText(i18n.t('web.sidebar.noRecent'))).toBeInTheDocument();
  release();
  expect(await screen.findByRole('link', { name: 'Default' })).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Loading projects' })).not.toBeInTheDocument();
  cleanup();

  serveLibrary({ projects: [] });
  renderRoute('/', { me });
  expect(await screen.findByText(i18n.t('web.sidebar.noProjects'))).toBeInTheDocument();
  cleanup();

  let requests = 0;
  serveLibrary();
  server.use(
    http.get(`${API}/projects`, () => {
      requests += 1;
      return apiError(500, 'internal', 'Pinwall ran into an unexpected problem.');
    }),
  );
  const { user } = renderRoute('/', { me });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Pinwall ran into an unexpected problem.');
  await user.click(within(alert).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(requests).toBe(2));
});

test('archived projects load only when their disclosure opens', async () => {
  const seen = serveLibrary();
  const { user } = renderRoute('/projects/prj_9', { me });
  const toggle = await screen.findByRole('button', { name: 'Archived' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await screen.findByRole('link', { name: 'Default' });
  expect(seen.archived).toBe(0);

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const archived = await screen.findByRole('link', { name: 'Old site' });
  expect(archived).toHaveAttribute('href', '/projects/prj_9');
  expect(archived).toHaveAttribute('aria-current', 'page');
  expect(seen.archived).toBe(1);
});

test('collapses to a rail and remembers it per user', async () => {
  serveLibrary();
  const { user } = renderRoute('/', { me });
  await user.click(await screen.findByRole('button', { name: 'Close sidebar' }));

  expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();
  const rail = sidebar();
  expect(within(rail).getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  expect(within(rail).getByRole('button', { name: 'New project' })).toBeInTheDocument();
  expect(within(rail).getByRole('button', { name: 'Search' })).toBeInTheDocument();
  expect(within(rail).getByRole('link', { name: 'All artifacts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(within(rail).getByRole('button', { name: 'Ada Lovelace' })).toBeInTheDocument();
  expect(localStorage.getItem('pinwall:sidebar:usr_1')).toBe('rail');
  cleanup();

  renderRoute('/', { me });
  expect(await screen.findByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();
  cleanup();

  // Someone else on the same browser keeps their own choice.
  renderRoute('/', { me: fx.me({ id: 'usr_2' }) });
  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
});

test('the toggle keeps keyboard focus when the sidebar collapses and expands', async () => {
  serveLibrary();
  const { user } = renderRoute('/', { me });
  (await screen.findByRole('button', { name: 'Close sidebar' })).focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('button', { name: 'Open sidebar' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('button', { name: 'Close sidebar' })).toHaveFocus();
});

test('opening an artifact shows the rail without changing the saved state', async () => {
  serveLibrary();
  localStorage.setItem('pinwall:sidebar:usr_1', 'open');
  const { user, router } = renderRoute('/a/art_1', { me });

  const expand = await screen.findByRole('button', { name: 'Open sidebar' });
  expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();

  // Expanding on the review screen lays the sidebar over the page for now.
  await user.click(expand);
  const drawer = await screen.findByRole('dialog', { name: 'Menu' });
  expect(within(drawer).getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  expect(localStorage.getItem('pinwall:sidebar:usr_1')).toBe('open');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(expand).toHaveFocus();

  await act(() => router.navigate('/'));
  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  expect(localStorage.getItem('pinwall:sidebar:usr_1')).toBe('open');
});

test('on a phone the sidebar is a drawer', async () => {
  serveLibrary();
  setViewport(360);
  const { user, router } = renderRoute('/', { me });

  const openMenu = await screen.findByRole('button', { name: 'Open menu' });
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

  await user.click(openMenu);
  const drawer = await screen.findByRole('dialog', { name: 'Menu' });
  expect(within(drawer).getByRole('link', { name: 'All artifacts' })).toBeInTheDocument();
  await user.click(await within(drawer).findByRole('link', { name: 'Launch site' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(router.state.location.pathname).toBe('/projects/prj_2');

  // An action in the drawer closes it first, then opens its dialog.
  await user.click(screen.getByRole('button', { name: 'Open menu' }));
  const again = await screen.findByRole('dialog', { name: 'Menu' });
  await user.click(within(again).getByRole('button', { name: 'New project' }));
  expect(await screen.findByRole('dialog', { name: 'New project' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
});

test('new project dialog creates a project and opens it', async () => {
  const created = fx.project({ id: 'prj_new', name: 'Site' });
  let projects = [defaultProject, launchSite];
  serveLibrary();
  server.use(http.get(`${API}/projects`, () => HttpResponse.json(fx.page(projects))));
  const bodies: unknown[] = [];
  server.use(
    http.post(`${API}/projects`, async ({ request }) => {
      bodies.push(await request.json());
      projects = [...projects, created];
      return HttpResponse.json(created, { status: 201 });
    }),
  );
  const { user, router } = renderRoute('/', { me });

  await user.click(
    await within(await screen.findByRole('navigation')).findByRole('button', {
      name: 'New project',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  const name = within(dialog).getByRole('textbox', { name: 'Name' });
  expect(name).toHaveFocus();
  expect(name).toHaveAttribute('maxlength', '100');

  await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
  expect(within(dialog).getByText(i18n.t('web.newProject.nameRequired'))).toBeInTheDocument();
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(name).toHaveFocus();
  expect(bodies).toEqual([]);

  await user.type(name, 'Site{Enter}');
  await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj_new'));
  expect(bodies).toEqual([{ name: 'Site', instructions: '' }]);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await screen.findByRole('link', { name: 'Site' })).toHaveAttribute('aria-current', 'page');

  // A server refusal is shown as the server worded it, and the dialog stays open.
  server.use(
    http.post(`${API}/projects`, () =>
      apiError(400, 'validation', 'Some fields are missing or invalid.'),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'New project' }));
  const retry = await screen.findByRole('dialog', { name: 'New project' });
  expect(within(retry).getByRole('textbox', { name: 'Name' })).toHaveValue('');
  await user.type(within(retry).getByRole('textbox', { name: 'Name' }), 'Another');
  await user.type(within(retry).getByRole('textbox', { name: /Instructions/ }), 'Use English.');
  await user.click(within(retry).getByRole('button', { name: 'Create project' }));
  expect(await within(retry).findByText('Some fields are missing or invalid.')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/projects/prj_new');
});

test('search opens with mod+K, shows live results and goes to all results on Enter', async () => {
  serveLibrary();
  const searches: string[] = [];
  server.use(
    http.get(`${API}/artifacts`, ({ request }) => {
      const url = new URL(request.url);
      searches.push(url.search);
      const hits =
        url.searchParams.get('q') === 'chup'
          ? [fx.artifact({ id: 'art_1', name: 'Chụp ảnh cưới', project_id: 'prj_2' })]
          : [];
      return HttpResponse.json(fx.page(hits));
    }),
  );
  const { user, router } = renderRoute('/', { me });
  await screen.findByRole('link', { name: 'Launch site' });

  await user.keyboard('{Control>}k{/Control}');
  const input = await screen.findByRole('combobox', { name: 'Search artifacts' });
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute('maxlength', '256');
  expect(input).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText(i18n.t('web.search.enterHint'))).toBeInTheDocument();

  await user.type(input, 'chup');
  const option = await screen.findByRole('option', { name: /Chụp ảnh cưới/ });
  expect(option).toHaveTextContent('Launch site');
  expect(searches).toEqual(['?q=chup&limit=8']);
  expect(input).toHaveAttribute('aria-expanded', 'true');
  const listbox = screen.getByRole('listbox');
  expect(input).toHaveAttribute('aria-controls', listbox.id);
  expect(input).not.toHaveAttribute('aria-activedescendant');

  await user.keyboard('{ArrowDown}');
  expect(input).toHaveAttribute('aria-activedescendant', option.id);
  expect(option).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // Reopened, it starts empty; Enter with nothing highlighted shows every result.
  await user.keyboard('{Control>}k{/Control}');
  const again = await screen.findByRole('combobox', { name: 'Search artifacts' });
  expect(again).toHaveValue('');
  await user.type(again, 'chup');
  await screen.findByRole('option', { name: /Chụp ảnh cưới/ });
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(router.state.location.pathname + router.state.location.search).toBe('/search?q=chup'),
  );

  await user.keyboard('{Control>}k{/Control}');
  await user.type(await screen.findByRole('combobox'), 'zzz');
  expect(await screen.findByText(i18n.t('web.search.noResults', { q: 'zzz' }))).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
});

test('account menu shows Admin only to admins and signs out', async () => {
  serveLibrary();
  const member = renderRoute('/', { me: fx.me({ id: 'usr_1', role: 'member' }) });
  await member.user.click(await screen.findByRole('button', { name: 'Ada Lovelace' }));
  const memberMenu = await screen.findByRole('menu');
  expect(within(memberMenu).getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  expect(
    within(memberMenu).getByRole('menuitem', { name: 'Connect an agent' }),
  ).toBeInTheDocument();
  expect(within(memberMenu).queryByRole('menuitem', { name: 'Admin' })).not.toBeInTheDocument();
  cleanup();

  const { user, router, queryClient } = renderRoute('/', { me });
  await user.click(await screen.findByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Admin' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));

  let signedOut = 0;
  server.use(
    http.post(`${API}/auth/sign-out`, () => {
      signedOut += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(signedOut).toBe(1);
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey),
  ).toEqual([]);
});

test('a skip link jumps to the content, and navigation focuses the page heading', async () => {
  serveLibrary();
  const { user } = renderRoute('/', { me });
  const heading = await screen.findByRole('heading', { level: 1 });
  // The first page leaves focus alone.
  expect(heading).not.toHaveFocus();

  await user.tab();
  expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('main')).toHaveFocus();

  await user.click(await screen.findByRole('link', { name: 'Launch site' }));
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
});

test('a page that loads later takes the focus when its heading appears', async () => {
  serveLibrary();
  const Later = lazy(async () => ({ default: () => <PageHeader title="Later page" /> }));
  const { router } = renderRoute('/', {
    me,
    routes: [
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { path: '/', element: <PageHeader title="First page" /> },
          { path: '/later', element: <Later /> },
        ],
      },
    ],
  });
  expect(await screen.findByRole('heading', { name: 'First page' })).not.toHaveFocus();
  await act(() => router.navigate('/later'));
  expect(await screen.findByRole('heading', { name: 'Later page' })).toHaveFocus();
});

test('the sidebar is reachable from the keyboard in reading order', async () => {
  serveLibrary();
  const { user } = renderRoute('/', { me });
  await screen.findByRole('link', { name: 'Launch site' });
  await screen.findByRole('link', { name: 'Security report' });
  const nav = sidebar();
  const order = [
    screen.getByRole('link', { name: 'Skip to content' }),
    within(nav).getByRole('link', { name: 'Pinwall' }),
    within(nav).getByRole('button', { name: 'Close sidebar' }),
    within(nav).getByRole('button', { name: 'New project' }),
    within(nav).getByRole('button', { name: 'Search' }),
    within(nav).getByRole('link', { name: 'All artifacts' }),
    within(nav).getByRole('link', { name: 'Default' }),
    within(nav).getByRole('link', { name: 'Launch site' }),
    within(nav).getByRole('button', { name: 'Archived' }),
    within(nav).getByRole('link', { name: 'Pricing page' }),
    within(nav).getByRole('link', { name: 'Security report' }),
    within(nav).getByRole('button', { name: 'Ada Lovelace' }),
  ];
  for (const element of order) {
    await user.tab();
    expect(element).toHaveFocus();
  }
});
