import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import type { Project, UpdateProjectRequest } from '../api/dto.ts';
import { INSTRUCTIONS_MAX } from '../api/library.ts';
import i18n from '../i18n.ts';
import { fx } from '../test/fixtures.ts';
import { hoursAgo, serveArtifacts, serveSidebar } from '../test/library.ts';
import { renderRoute } from '../test/render.tsx';
import { API, apiError, server } from '../test/server.ts';

const me = fx.me({ id: 'usr_1' });
const defaultProject = fx.project({ id: 'prj_1', name: 'Default', is_default: true });

/**
 * Serves one project and its artifacts, and takes PATCHes: each body is
 * recorded and merged into the project the server holds, unless `refuse`
 * answers instead.
 */
function serveProject(
  start: Project,
  o: {
    artifacts?: ReturnType<typeof fx.artifact>[];
    refuse?: (body: UpdateProjectRequest) => Response | null;
  } = {},
) {
  let current = start;
  const patches: UpdateProjectRequest[] = [];
  serveSidebar({ projects: [defaultProject, start] });
  const artifactRequests = serveArtifacts(() => HttpResponse.json(fx.page(o.artifacts ?? [])));
  server.use(
    http.get(`${API}/projects/${start.id}`, () => HttpResponse.json(current)),
    http.patch(`${API}/projects/${start.id}`, async ({ request }) => {
      const body = (await request.json()) as UpdateProjectRequest;
      patches.push(body);
      const refusal = o.refuse?.(body);
      if (refusal) return refusal;
      const { archived, ...rest } = body;
      current = {
        ...current,
        ...rest,
        ...(archived === undefined ? {} : { archived_at: archived ? Date.now() : null }),
      };
      return HttpResponse.json(current);
    }),
  );
  return { patches, artifactRequests };
}

function instructionsBox() {
  return screen.getByRole('region', { name: 'Instructions for agents' });
}

const launchSite = fx.project({
  id: 'prj_2',
  name: 'Launch site',
  artifact_count: 3,
  instructions: 'Use Vietnamese.\nThe main color is #FF4F8B.',
  updated_at: hoursAgo(72),
});

test('project page shows title, counts and instructions', async () => {
  const { artifactRequests } = serveProject(launchSite, {
    artifacts: [
      fx.artifact({ id: 'art_1', name: 'Homepage', project_id: 'prj_2', updated_at: hoursAgo(2) }),
      fx.artifact({ id: 'art_2', name: 'Pricing', project_id: 'prj_2', updated_at: hoursAgo(5) }),
      fx.artifact({ id: 'art_3', name: 'Báo cáo', project_id: 'prj_2', updated_at: hoursAgo(9) }),
    ],
  });
  renderRoute('/projects/prj_2', { me });

  expect(await screen.findByRole('heading', { level: 1, name: 'Launch site' })).toBeInTheDocument();
  expect(await screen.findByText('3 artifacts · updated 2 hours ago')).toBeInTheDocument();
  const box = instructionsBox();
  expect(
    within(box).getByText(/Use Vietnamese\.\s+The main color is #FF4F8B\./),
  ).toBeInTheDocument();
  expect(
    within(box).getByText('Agents read this over MCP before they publish to this project.'),
  ).toBeInTheDocument();

  const list = screen.getByRole('list', { name: 'Artifacts' });
  expect(
    within(list)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href')),
  ).toEqual(['/a/art_1', '/a/art_2', '/a/art_3']);
  expect(artifactRequests).toEqual(['?project_id=prj_2&limit=48']);
  await waitFor(() => expect(document.title).toBe('Launch site · Pinwall'));
});

test('instructions edit inline: mod+Enter saves, Escape cancels', async () => {
  const { patches } = serveProject(launchSite, {
    refuse: (body) =>
      body.instructions === 'refused'
        ? apiError(400, 'validation', 'Instructions must be plain text.')
        : null,
  });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  // mod+Enter saves exactly what was typed.
  await user.click(within(instructionsBox()).getByRole('button', { name: 'Edit' }));
  const box = within(instructionsBox()).getByRole('textbox', { name: 'Instructions for agents' });
  expect(box).toHaveFocus();
  expect(box).toHaveValue(launchSite.instructions);
  await user.clear(box);
  await user.type(box, 'Dùng tiếng Việt');
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() => expect(patches).toEqual([{ instructions: 'Dùng tiếng Việt' }]));
  expect(await within(instructionsBox()).findByText('Dùng tiếng Việt')).toBeInTheDocument();
  expect(within(instructionsBox()).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(instructionsBox()).getByRole('button', { name: 'Edit' })).toHaveFocus();

  // Escape puts the saved text back and sends nothing.
  await user.click(within(instructionsBox()).getByRole('button', { name: 'Edit' }));
  await user.type(within(instructionsBox()).getByRole('textbox'), ' và tiếng Anh');
  await user.keyboard('{Escape}');
  expect(within(instructionsBox()).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(instructionsBox()).getByText('Dùng tiếng Việt')).toBeInTheDocument();
  expect(patches).toHaveLength(1);

  // Over the limit: the counter shows by how much, and nothing can be saved.
  await user.click(within(instructionsBox()).getByRole('button', { name: 'Edit' }));
  const long = within(instructionsBox()).getByRole('textbox');
  await user.clear(long);
  await user.click(long);
  await user.paste('x'.repeat(INSTRUCTIONS_MAX + 1));
  expect(within(instructionsBox()).getByText('20,001 / 20,000')).toBeInTheDocument();
  expect(long).toHaveAttribute('aria-invalid', 'true');
  expect(within(instructionsBox()).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(within(instructionsBox()).getByRole('alert')).toHaveTextContent(
    i18n.t('web.instructions.tooLong', { max: '20,000' }),
  );
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(patches).toHaveLength(1);

  // A refusal is shown as the server worded it, and the draft stays.
  await user.clear(long);
  await user.type(long, 'refused');
  await user.click(within(instructionsBox()).getByRole('button', { name: 'Save' }));
  expect(await within(instructionsBox()).findByRole('alert')).toHaveTextContent(
    'Instructions must be plain text.',
  );
  expect(within(instructionsBox()).getByRole('textbox')).toHaveValue('refused');
  expect(patches).toHaveLength(2);
});

test('an empty instructions box invites adding them', async () => {
  serveProject(fx.project({ id: 'prj_2', name: 'Launch site', instructions: '' }));
  renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });
  expect(within(instructionsBox()).getByText(i18n.t('web.instructions.empty'))).toBeInTheDocument();
  expect(
    within(instructionsBox()).getByRole('button', { name: 'Add instructions' }),
  ).toBeInTheDocument();
});

test('rename and archive from the project menu', async () => {
  const { patches } = serveProject(launchSite);
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  await user.click(screen.getByRole('button', { name: 'Project options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename project' });
  const name = within(dialog).getByRole('textbox', { name: 'Name' });
  expect(name).toHaveValue('Launch site');
  await user.clear(name);
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText(i18n.t('web.project.nameRequired'))).toBeInTheDocument();
  expect(patches).toEqual([]);
  await user.type(name, 'New{Enter}');
  expect(await screen.findByRole('heading', { level: 1, name: 'New' })).toBeInTheDocument();
  expect(patches).toEqual([{ name: 'New' }]);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: 'Project options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
  expect(await screen.findByText(i18n.t('web.project.archivedBanner'))).toBeInTheDocument();
  expect(patches).toEqual([{ name: 'New' }, { archived: true }]);
  expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: 'Project options' }));
  expect(await screen.findByRole('menuitem', { name: 'Unarchive' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');

  await user.click(screen.getByRole('button', { name: 'Unarchive' }));
  await waitFor(() =>
    expect(screen.queryByText(i18n.t('web.project.archivedBanner'))).not.toBeInTheDocument(),
  );
  expect(patches).toEqual([{ name: 'New' }, { archived: true }, { archived: false }]);
  cleanup();

  // The default project can be renamed but never archived.
  serveProject(defaultProject);
  const other = renderRoute('/projects/prj_1', { me });
  await screen.findByRole('heading', { level: 1, name: 'Default' });
  await other.user.click(screen.getByRole('button', { name: 'Project options' }));
  expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Unarchive' })).not.toBeInTheDocument();
});

test('a refused archive is shown as the server worded it', async () => {
  serveProject(launchSite, {
    refuse: () => apiError(409, 'conflict', 'The default project cannot be archived.'),
  });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });
  await user.click(screen.getByRole('button', { name: 'Project options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
  expect(await screen.findByText('The default project cannot be archived.')).toBeInTheDocument();
  expect(screen.queryByText(i18n.t('web.project.archivedBanner'))).not.toBeInTheDocument();
});

test('an empty project offers upload and connecting an agent', async () => {
  serveProject(fx.project({ id: 'prj_2', name: 'Launch site', artifact_count: 0 }));
  renderRoute('/projects/prj_2', { me });
  expect(await screen.findByText(i18n.t('web.project.emptyTitle'))).toBeInTheDocument();
  expect(screen.getByText(/^0 artifacts · updated /)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload files' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Connect an agent' })).toHaveAttribute(
    'href',
    '/connect',
  );
});

test('a project that does not exist shows the server message', async () => {
  serveSidebar();
  serveArtifacts(() => apiError(404, 'not_found', 'This project does not exist.'));
  server.use(
    http.get(`${API}/projects/prj_404`, () =>
      apiError(404, 'not_found', 'This project does not exist.'),
    ),
  );
  renderRoute('/projects/prj_404', { me });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Project not available' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('This project does not exist.');
  expect(screen.getByRole('link', { name: 'Go to All artifacts' })).toHaveAttribute('href', '/');
});
