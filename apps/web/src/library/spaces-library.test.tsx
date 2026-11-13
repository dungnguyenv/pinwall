import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { delay, HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import type { ArtifactSummary, Project, PublishResult } from '../api/dto.ts';
import i18n from '../i18n.ts';
import { fakeDrop, file } from '../test/fake-entries.ts';
import { fx } from '../test/fixtures.ts';
import { serveArtifacts, serveSidebar } from '../test/library.ts';
import { formParts } from '../test/multipart.ts';
import { renderRoute } from '../test/render.tsx';
import { API, server } from '../test/server.ts';
import { BOB, fxOwn, fxShared, PERSONAL } from '../test/spaces.ts';

const t = i18n.t.bind(i18n);

const myDefault = fxOwn({ id: 'prj_d', name: 'Default', is_default: true });

const published: PublishResult = {
  artifact_id: 'art_9',
  version_id: 'ver_9',
  version_number: 1,
  kind: 'html',
  entry_path: 'index.html',
  file_count: 1,
  total_bytes: 40,
  review_url: 'http://localhost:3000/a/art_9',
  raw_url: 'http://localhost:3000/a/art_9/v/1/raw',
  warnings: [],
};

/**
 * Serves a library page: the sidebar's projects (and `archived`), `project` by
 * id, an artifact list, and the upload endpoint, recording each upload's target.
 */
function serveSpace(o: {
  projects: Project[];
  archived?: Project[];
  project?: Project;
  artifacts?: ArtifactSummary[];
}) {
  const uploads: string[] = [];
  serveSidebar({ projects: o.projects });
  server.use(
    http.get(`${API}/projects`, ({ request }) => {
      const archived = new URL(request.url).searchParams.get('archived') === 'true';
      return HttpResponse.json(fx.page(archived ? (o.archived ?? []) : o.projects));
    }),
  );
  serveArtifacts(() => HttpResponse.json(fx.page(o.artifacts ?? [])));
  const { project } = o;
  if (project)
    server.use(http.get(`${API}/projects/${project.id}`, () => HttpResponse.json(project)));
  server.use(
    http.get(`${API}/artifacts/art_9`, () =>
      HttpResponse.json(
        fx.artifact({ id: 'art_9', name: 'E2E Site', project_id: project?.id ?? 'prj_d' }),
      ),
    ),
    http.post(`${API}/publish/upload`, async ({ request }) => {
      const parts = await formParts(request);
      uploads.push(parts.find(([name]) => name === 'target')?.[1] ?? '');
      return HttpResponse.json(published, { status: 201 });
    }),
  );
  return { uploads };
}

const sidebar = () => screen.getByRole('navigation', { name: 'Main' });
const main = () => screen.getByRole('main');

const linkNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');

/** Drags `files` in from outside the window and drops them; false when the page took the drop. */
function dropFiles(): boolean {
  const dt = fakeDrop([file('index.html')]);
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  fireEvent.dragOver(document.body, { dataTransfer: dt });
  return fireEvent.drop(document.body, { dataTransfer: dt });
}

test('team mode: no Shared with me, every project under Projects', async () => {
  serveSpace({
    projects: [fx.project({ name: 'Alpha' }), fx.project({ id: 'prj_2', name: 'Beta' })],
  });
  renderRoute('/');

  const projects = await screen.findByRole('list', { name: 'Projects' });
  expect(linkNames(projects)).toEqual(['Alpha', 'Beta']);
  expect(within(sidebar()).queryByText(t('web.sidebar.shared'))).not.toBeInTheDocument();
});

test('personal mode: own projects under Projects, shared ones under Shared with me with owner and role', async () => {
  serveSpace({
    projects: [
      myDefault,
      fxOwn({ id: 'prj_l', name: 'Launch' }),
      fxShared('viewer', { id: 'prj_p', name: 'Pricing' }),
      fxShared('editor', { id: 'prj_o', name: 'Docs', owner: null }),
    ],
  });
  renderRoute('/', { config: PERSONAL });

  const projects = await screen.findByRole('list', { name: 'Projects' });
  expect(linkNames(projects)).toEqual(['Default', 'Launch']);

  const shared = screen.getByRole('list', { name: 'Shared with me' });
  expect(within(shared).getByText('Pricing')).toBeInTheDocument();
  expect(within(shared).getByText(`${BOB.name} · Viewer`)).toBeInTheDocument();
  expect(within(shared).getByText('Docs')).toBeInTheDocument();
  expect(within(shared).getByText('Someone · Editor')).toBeInTheDocument();
  expect(within(shared).getByRole('link', { name: /^Pricing/ })).toHaveAttribute(
    'href',
    '/projects/prj_p',
  );
  expect(within(projects).queryByText(/Viewer|Editor/)).not.toBeInTheDocument();
});

test('a shared project that is its owner default is not the first of anything', async () => {
  serveSpace({
    projects: [
      fxShared('editor', { id: 'prj_bd', name: 'Bob default', is_default: true }),
      fxShared('viewer', { id: 'prj_p', name: 'Pricing' }),
      myDefault,
    ],
  });
  renderRoute('/', { config: PERSONAL });

  const projects = await screen.findByRole('list', { name: 'Projects' });
  expect(linkNames(projects)).toEqual(['Default']);
  const shared = screen.getByRole('list', { name: 'Shared with me' });
  // The server's order, oldest first, is kept.
  expect(linkNames(shared)).toEqual([
    `Bob default${BOB.name} · Editor`,
    `Pricing${BOB.name} · Viewer`,
  ]);
});

test('Shared with me is absent when nothing is shared', async () => {
  serveSpace({ projects: [myDefault, fxOwn({ id: 'prj_l', name: 'Launch' })] });
  renderRoute('/', { config: PERSONAL });

  const projects = await screen.findByRole('list', { name: 'Projects' });
  expect(linkNames(projects)).toEqual(['Default', 'Launch']);
  expect(within(sidebar()).queryByText(t('web.sidebar.shared'))).not.toBeInTheDocument();
});

test('the archived list keeps one list, and its shared rows say whose they are', async () => {
  serveSpace({
    projects: [myDefault],
    archived: [
      fxOwn({ id: 'prj_a', name: 'Old site', archived_at: Date.UTC(2026, 9, 1) }),
      fxShared('viewer', { id: 'prj_b', name: 'Old pricing', archived_at: Date.UTC(2026, 9, 2) }),
    ],
  });
  const { user } = renderRoute('/', { config: PERSONAL });

  await user.click(await screen.findByRole('button', { name: 'Archived' }));
  const archived = await screen.findByRole('list', { name: 'Archived' });
  expect(linkNames(archived)).toEqual(['Old site', `Old pricing${BOB.name} · Viewer`]);
});

test("All artifacts uploads into the person's own default project, never a shared one", async () => {
  const { uploads } = serveSpace({
    projects: [
      fxShared('editor', { id: 'prj_bd', name: 'Bob default', is_default: true }),
      myDefault,
    ],
  });
  const { user } = renderRoute('/', { config: PERSONAL });
  await screen.findByRole('list', { name: 'Projects' });

  await user.click(within(main()).getByRole('button', { name: t('web.upload.action') }));
  expect(
    await screen.findByRole('dialog', { name: t('web.upload.title', { project: 'Default' }) }),
  ).toBeInTheDocument();
  await user.keyboard('{Escape}');

  const dt = fakeDrop([file('index.html')]);
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  expect(
    await screen.findByText(t('web.upload.dropHere', { project: 'Default' })),
  ).toBeInTheDocument();
  fireEvent.drop(document.body, { dataTransfer: dt });
  await waitFor(() => expect(uploads).toEqual(['{}']));
  expect(await screen.findByText('Published “E2E Site” v1')).toBeInTheDocument();
});

test('with no default project of their own, the upload names the default project', async () => {
  serveSpace({
    projects: [fxShared('editor', { id: 'prj_bd', name: 'Bob default', is_default: true })],
  });
  const { user } = renderRoute('/', { config: PERSONAL });
  await screen.findByRole('list', { name: 'Shared with me' });

  await user.click(within(main()).getByRole('button', { name: t('web.upload.action') }));
  expect(
    await screen.findByRole('dialog', {
      name: t('web.upload.title', { project: t('web.upload.defaultProject') }),
    }),
  ).toBeInTheDocument();
});

test('a new person sees the empty space with three ways to start', async () => {
  serveSpace({ projects: [myDefault] });
  const { user } = renderRoute('/', { config: PERSONAL });

  expect(await screen.findByText(t('web.library.spaceEmptyTitle'))).toBeInTheDocument();
  expect(within(main()).getByText(t('web.library.spaceEmptyBody'))).toBeInTheDocument();
  expect(within(main()).getByRole('link', { name: 'Connect an agent' })).toHaveAttribute(
    'href',
    '/connect',
  );

  await user.click(within(main()).getByRole('button', { name: t('web.upload.actionFiles') }));
  expect(
    await screen.findByRole('dialog', { name: t('web.upload.title', { project: 'Default' }) }),
  ).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  await user.click(within(main()).getByRole('button', { name: t('web.sidebar.newProject') }));
  expect(
    await screen.findByRole('dialog', { name: t('web.newProject.title') }),
  ).toBeInTheDocument();
});

test('team mode keeps the 1.0 empty library', async () => {
  serveSpace({ projects: [fx.project({ id: 'prj_1', name: 'Default', is_default: true })] });
  renderRoute('/');

  expect(await screen.findByText(t('web.library.emptyTitle'))).toBeInTheDocument();
  expect(screen.queryByText(t('web.library.spaceEmptyTitle'))).not.toBeInTheDocument();
  expect(within(main()).queryByRole('button', { name: t('web.sidebar.newProject') })).toBeNull();
  expect(within(main()).getByRole('link', { name: 'Connect an agent' })).toBeInTheDocument();
});

test('a viewer gets no upload or publish controls on the project page', async () => {
  const project = fxShared('viewer', { id: 'prj_1', name: 'Pricing', instructions: '' });
  const { uploads } = serveSpace({ projects: [myDefault, project], project });
  renderRoute('/projects/prj_1', { config: PERSONAL });

  const heading = await screen.findByRole('heading', { level: 1, name: 'Pricing' });
  const header = heading.closest('header') as HTMLElement;
  expect(
    within(header).getByText(t('web.project.sharedViewer', { owner: BOB.name })),
  ).toBeInTheDocument();
  expect(within(header).getByText(/^0 artifacts · updated /)).toBeInTheDocument();

  expect(screen.queryByRole('button', { name: t('web.upload.action') })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: t('web.upload.actionFiles') }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: t('web.project.menu') })).not.toBeInTheDocument();

  const instructions = screen.getByRole('region', { name: t('web.instructions.title') });
  expect(within(instructions).getByText(t('web.project.noInstructions'))).toBeInTheDocument();
  expect(within(instructions).queryByRole('button')).not.toBeInTheDocument();

  // The empty state offers only a way to connect an agent.
  expect(await screen.findByText(t('web.project.viewerEmptyBody'))).toBeInTheDocument();
  expect(within(main()).getByRole('link', { name: 'Connect an agent' })).toBeInTheDocument();
  expect(within(main()).queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();

  // A drop says why and sends nothing; the browser does not open the file either.
  const dt = fakeDrop([file('index.html')]);
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  expect(await screen.findByText(t('web.upload.viewerOnly'))).toBeInTheDocument();
  expect(fireEvent.drop(document.body, { dataTransfer: dt })).toBe(false);
  await act(() => delay(20));
  expect(uploads).toEqual([]);
});

test('a viewer reads the instructions but cannot edit them', async () => {
  const project = fxShared('viewer', {
    id: 'prj_1',
    name: 'Pricing',
    instructions: 'Use Vietnamese.',
  });
  serveSpace({ projects: [myDefault, project], project });
  renderRoute('/projects/prj_1', { config: PERSONAL });

  const instructions = await screen.findByRole('region', { name: t('web.instructions.title') });
  expect(within(instructions).getByText('Use Vietnamese.')).toBeInTheDocument();
  expect(within(instructions).queryByRole('button')).not.toBeInTheDocument();
});

test('an editor uploads, but cannot rename, archive or change the instructions', async () => {
  const project = fxShared('editor', {
    id: 'prj_1',
    name: 'Pricing',
    instructions: 'Use Vietnamese.',
  });
  const { uploads } = serveSpace({ projects: [myDefault, project], project });
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });

  const heading = await screen.findByRole('heading', { level: 1, name: 'Pricing' });
  expect(
    within(heading.closest('header') as HTMLElement).getByText(
      t('web.project.sharedEditor', { owner: BOB.name }),
    ),
  ).toBeInTheDocument();

  expect(screen.queryByRole('button', { name: t('web.project.menu') })).not.toBeInTheDocument();
  const instructions = screen.getByRole('region', { name: t('web.instructions.title') });
  expect(within(instructions).getByText('Use Vietnamese.')).toBeInTheDocument();
  expect(within(instructions).queryByRole('button')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: t('web.upload.action') }));
  expect(
    await screen.findByRole('dialog', { name: t('web.upload.title', { project: 'Pricing' }) }),
  ).toBeInTheDocument();
  await user.keyboard('{Escape}');

  dropFiles();
  await waitFor(() => expect(uploads).toEqual(['{"project_id":"prj_1"}']));
  expect(await screen.findByText('Published “E2E Site” v1')).toBeInTheDocument();
});

test('an owner of a project in personal mode keeps every control', async () => {
  const project = fxOwn({ id: 'prj_1', name: 'Launch', instructions: 'Use Vietnamese.' });
  serveSpace({ projects: [myDefault, project], project });
  renderRoute('/projects/prj_1', { config: PERSONAL });

  const heading = await screen.findByRole('heading', { level: 1, name: 'Launch' });
  const header = heading.closest('header') as HTMLElement;
  expect(within(header).queryByText(/'s project/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('web.upload.action') })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('web.project.menu') })).toBeInTheDocument();
  expect(
    within(screen.getByRole('region', { name: t('web.instructions.title') })).getByRole('button', {
      name: t('web.instructions.edit'),
    }),
  ).toBeInTheDocument();
});

test('an archived shared project has no Unarchive for its viewer', async () => {
  const project = fxShared('editor', {
    id: 'prj_1',
    name: 'Pricing',
    archived_at: Date.UTC(2026, 9, 1),
  });
  serveSpace({ projects: [myDefault], project });
  renderRoute('/projects/prj_1', { config: PERSONAL });

  expect(await screen.findByText(t('web.project.archivedBanner'))).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: t('web.project.unarchive') }),
  ).not.toBeInTheDocument();
});

test('project controls stay hidden while the role loads', async () => {
  const project = fxOwn({ id: 'prj_1', name: 'Launch' });
  serveSpace({ projects: [myDefault, project] });
  let answer: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  server.use(
    http.get(`${API}/projects/prj_1`, async () => {
      await gate;
      return HttpResponse.json(project);
    }),
  );
  renderRoute('/projects/prj_1', { config: PERSONAL });

  expect(await screen.findByRole('status', { name: t('web.project.loading') })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: t('web.upload.action') })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: t('web.project.menu') })).not.toBeInTheDocument();

  answer();
  expect(await screen.findByRole('button', { name: t('web.upload.action') })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('web.project.menu') })).toBeInTheDocument();
});

test('team mode: a later default project offers no Archive, as the server refuses it', async () => {
  const later = fx.project({ id: 'prj_2', name: 'Second', is_default: false });
  serveSpace({
    projects: [fx.project({ id: 'prj_t', name: 'Team default', is_default: true }), later],
    // The project's own answer says what the server will refuse.
    project: { ...later, is_default: true },
  });
  const { user } = renderRoute('/projects/prj_2');

  await screen.findByRole('heading', { level: 1, name: 'Second' });
  // Lists keep showing it as an ordinary project.
  expect(linkNames(await screen.findByRole('list', { name: 'Projects' }))).toEqual([
    'Team default',
    'Second',
  ]);

  await user.click(screen.getByRole('button', { name: t('web.project.menu') }));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: t('web.project.rename') })).toBeInTheDocument();
  expect(within(menu).queryByRole('menuitem', { name: t('web.project.archive') })).toBeNull();
});

test('names render as text', async () => {
  const markup = '<img src=x onerror=alert(1)>';
  const project = fxShared('viewer', {
    id: 'prj_1',
    name: markup,
    owner: { id: BOB.id, name: '<b>Bob</b>' },
  });
  serveSpace({ projects: [myDefault, project], project });
  renderRoute('/projects/prj_1', { config: PERSONAL });

  const heading = await screen.findByRole('heading', { level: 1, name: markup });
  const shared = await screen.findByRole('list', { name: 'Shared with me' });
  expect(within(shared).getByText(markup)).toBeInTheDocument();
  expect(within(shared).getByText('<b>Bob</b> · Viewer')).toBeInTheDocument();
  expect(
    within(heading.closest('header') as HTMLElement).getByText(
      t('web.project.sharedViewer', { owner: '<b>Bob</b>' }),
    ),
  ).toBeInTheDocument();
  expect(document.querySelector('img, b')).toBeNull();
});
