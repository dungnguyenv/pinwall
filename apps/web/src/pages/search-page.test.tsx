import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { afterEach, expect, test } from 'vitest';
import i18n from '../i18n.ts';
import { fx } from '../test/fixtures.ts';
import { hoursAgo, serveArtifacts, serveSidebar } from '../test/library.ts';
import { renderRoute } from '../test/render.tsx';

const me = fx.me({ id: 'usr_1' });
const defaultProject = fx.project({ id: 'prj_1', name: 'Default', is_default: true });
const launchSite = fx.project({ id: 'prj_2', name: 'Launch site' });

afterEach(() => localStorage.clear());

test('search queries the server with the term as typed', async () => {
  serveSidebar({ projects: [defaultProject, launchSite] });
  const requests = serveArtifacts((params) =>
    HttpResponse.json(
      fx.page(
        params.get('q') === 'chup anh'
          ? [fx.artifact({ id: 'art_1', name: 'Chụp ảnh cưới', project_id: 'prj_2' })]
          : [],
      ),
    ),
  );
  const { user, router } = renderRoute('/search?q=chup%20anh', { me });

  expect(
    await screen.findByRole('heading', { level: 1, name: 'Results for “chup anh”' }),
  ).toBeInTheDocument();
  const box = screen.getByRole('searchbox', { name: 'Search artifacts' });
  expect(box).toHaveValue('chup anh');
  expect(box).toHaveAttribute('maxlength', '256');
  const results = await screen.findByRole('list', { name: i18n.t('web.search.results') });
  expect(within(results).getByRole('link', { name: 'Chụp ảnh cưới' })).toHaveAttribute(
    'href',
    '/a/art_1',
  );
  expect(requests).toEqual(['?q=chup+anh&limit=48']);
  await waitFor(() => expect(document.title).toBe('Results for “chup anh” · Pinwall'));

  // Enter puts the new term in the address; no match says so.
  await user.clear(box);
  await user.type(box, '  bao cao {Enter}');
  await waitFor(() => expect(router.state.location.search).toBe('?q=bao+cao'));
  expect(await screen.findByText(i18n.t('web.search.empty', { q: 'bao cao' }))).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Results for “bao cao”');
  expect(requests).toEqual(['?q=chup+anh&limit=48', '?q=bao+cao&limit=48']);

  // Back brings the last search, its term back in the box.
  await router.navigate(-1);
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Results for “chup anh”' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveValue('chup anh');
});

test('without a term the search page asks for one and sends nothing', async () => {
  serveSidebar();
  const requests = serveArtifacts(() => HttpResponse.json(fx.page([])));
  renderRoute('/search', { me });
  expect(await screen.findByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument();
  expect(screen.getByText(i18n.t('web.search.hint'))).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveValue('');
  expect(requests).toEqual([]);
});

test('all artifacts lists everything with project names in list view', async () => {
  localStorage.setItem('pinwall:library-view:usr_1', 'list');
  serveSidebar({ projects: [defaultProject, launchSite] });
  const requests = serveArtifacts(() =>
    HttpResponse.json(
      fx.page([
        fx.artifact({
          id: 'art_1',
          name: 'Bảng giá 2027',
          project_id: 'prj_2',
          current_version: fx.version({ number: 5 }),
          updated_at: hoursAgo(1),
        }),
        fx.artifact({
          id: 'art_2',
          name: 'Security report',
          kind: 'markdown',
          updated_at: hoursAgo(26),
        }),
      ]),
    ),
  );
  renderRoute('/', { me });

  expect(
    await screen.findByRole('heading', { level: 1, name: 'All artifacts' }),
  ).toBeInTheDocument();
  const list = await screen.findByRole('list', { name: 'All artifacts' });
  const rows = within(list).getAllByRole('link');
  expect(rows.map((row) => row.getAttribute('href'))).toEqual(['/a/art_1', '/a/art_2']);
  expect(within(list).getByRole('link', { name: 'Bảng giá 2027' })).toHaveAccessibleDescription(
    'Launch site · v5 · 1 hour ago',
  );
  expect(within(list).getByRole('link', { name: 'Security report' })).toHaveAccessibleDescription(
    'Default · v1 · yesterday',
  );
  expect(requests).toEqual(['?limit=48']);
  await waitFor(() => expect(document.title).toBe('All artifacts · Pinwall'));
});
