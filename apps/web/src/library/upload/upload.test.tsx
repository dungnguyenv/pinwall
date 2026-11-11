import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { expect, onTestFinished, test, vi } from 'vitest';
import type { Project, PublishResult, PublishWarning } from '../../api/dto.ts';
import type { LibraryArtifact } from '../../api/library.ts';
import i18n from '../../i18n.ts';
import { dir, fakeDrop, file, folderFile } from '../../test/fake-entries.ts';
import { fx } from '../../test/fixtures.ts';
import { serveArtifacts, serveSidebar } from '../../test/library.ts';
import { formParts } from '../../test/multipart.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { createUploadStore, UploadToast } from './upload-toast.tsx';

const t = i18n.t.bind(i18n);
const me = fx.me({ id: 'usr_1' });
const defaultProject = fx.project({ id: 'prj_1', name: 'Default', is_default: true });
const launchSite = fx.project({ id: 'prj_2', name: 'Launch site' });
const e2eSite = fx.artifact({ id: 'art_9', name: 'E2E Site', project_id: 'prj_2' });

function published(o: Partial<PublishResult> = {}): PublishResult {
  return {
    artifact_id: 'art_9',
    version_id: 'ver_9',
    version_number: 1,
    kind: 'html',
    entry_path: 'index.html',
    file_count: 2,
    total_bytes: 40,
    review_url: 'http://localhost:3000/a/art_9',
    raw_url: 'http://localhost:3000/a/art_9/v/1/raw',
    warnings: [],
    ...o,
  };
}

interface SentUpload {
  target: string;
  paths: string[];
  files: string[];
}

/**
 * Serves a library page around `project` (or All artifacts without one): the
 * sidebar, the project, its artifacts (a list the upload handler can change)
 * and `GET /artifacts/art_9`. Each upload is recorded and answered by `respond`.
 */
function serveLibrary(o: { project?: Project; respond?: () => Response | Promise<Response> }) {
  const state: { artifacts: LibraryArtifact[]; uploads: SentUpload[] } = {
    artifacts: [],
    uploads: [],
  };
  serveSidebar({ projects: o.project ? [defaultProject, o.project] : [defaultProject] });
  serveArtifacts(() => HttpResponse.json(fx.page(state.artifacts)));
  if (o.project) {
    const project = o.project;
    server.use(http.get(`${API}/projects/${project.id}`, () => HttpResponse.json(project)));
  }
  server.use(
    http.get(`${API}/artifacts/art_9`, () => HttpResponse.json(e2eSite)),
    http.post(`${API}/publish/upload`, async ({ request }) => {
      const parts = await formParts(request);
      state.uploads.push({
        target: parts.find(([name]) => name === 'target')?.[1] ?? '',
        paths: parts.filter(([name]) => name === 'path').map(([, value]) => value),
        files: parts.filter(([name]) => name === 'file').map(([, value]) => value),
      });
      if (o.respond) return o.respond();
      state.artifacts = [e2eSite];
      return HttpResponse.json(published(), { status: 201 });
    }),
  );
  return state;
}

/** Drags `dt` in from outside the window and drops it. */
function dragAndDrop(dt: DataTransfer) {
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  fireEvent.dragOver(document.body, { dataTransfer: dt });
  fireEvent.drop(document.body, { dataTransfer: dt });
}

/** The sonner toast that holds `text`. */
async function findToast(text: string | RegExp): Promise<HTMLElement> {
  const node = await screen.findByText(text);
  const toast = node.closest<HTMLElement>('[data-sonner-toast]');
  if (!toast) throw new Error(`"${String(text)}" is not in a toast`);
  return toast;
}

const site = () => dir('site', [file('index.html'), dir('css', [file('a.css')])]);
const dropHere = (project: string) => t('web.upload.dropHere', { project });

test('dropping a folder on the project page publishes into that project', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user, router } = renderRoute('/projects/prj_2', { me });
  expect(await screen.findByText(t('web.project.emptyTitle'))).toBeInTheDocument();

  dragAndDrop(fakeDrop([site()]));

  const toast = await findToast('Published “E2E Site” v1');
  expect(state.uploads).toEqual([
    {
      target: '{"project_id":"prj_2"}',
      paths: ['site/css/a.css', 'site/index.html'],
      files: ['a.css', 'index.html'],
    },
  ]);
  // The list refetches and shows the new artifact.
  expect(await screen.findByRole('link', { name: 'E2E Site' })).toHaveAttribute('href', '/a/art_9');
  expect(screen.queryByText(dropHere('Launch site'))).not.toBeInTheDocument();

  const open = within(toast).getByRole('link', { name: 'Open' });
  expect(open).toHaveAttribute('href', '/a/art_9');
  await user.click(open);
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_9'));
});

test('the overlay appears only for file drags', async () => {
  serveLibrary({ project: launchSite });
  renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  const text = fakeDrop([], { types: ['text/plain'] });
  fireEvent.dragEnter(document.body, { dataTransfer: text });
  expect(screen.queryByText(dropHere('Launch site'))).not.toBeInTheDocument();
  fireEvent.dragLeave(document.body, { dataTransfer: text });

  const files = fakeDrop([file('a.html')]);
  fireEvent.dragEnter(document.body, { dataTransfer: files });
  expect(screen.getByText(dropHere('Launch site'))).toBeInTheDocument();
  expect(screen.getByText(t('web.upload.hint'))).toBeInTheDocument();
  // Moving over the page's own elements keeps it up; leaving the window takes it down.
  fireEvent.dragEnter(screen.getByText(dropHere('Launch site')), { dataTransfer: files });
  fireEvent.dragLeave(document.body, { dataTransfer: files });
  expect(screen.getByText(dropHere('Launch site'))).toBeInTheDocument();
  fireEvent.dragLeave(screen.getByText(dropHere('Launch site')), { dataTransfer: files });
  expect(screen.queryByText(dropHere('Launch site'))).not.toBeInTheDocument();

  // Dragging something from the page itself is not an upload.
  const heading = screen.getByRole('heading', { level: 1, name: 'Launch site' });
  fireEvent.dragStart(heading, { dataTransfer: files });
  fireEvent.dragEnter(document.body, { dataTransfer: files });
  expect(screen.queryByText(dropHere('Launch site'))).not.toBeInTheDocument();
  fireEvent.dragEnd(heading, { dataTransfer: files });
  fireEvent.dragEnter(document.body, { dataTransfer: files });
  expect(screen.getByText(dropHere('Launch site'))).toBeInTheDocument();
});

test('a selection over the limit is refused without a request', async () => {
  const state = serveLibrary({ project: launchSite });
  renderRoute('/projects/prj_2', {
    me,
    config: { limits: { ...fx.config().limits, max_upload_bytes: 1_000, max_files: 2 } },
  });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([file('index.html', 1_500)]));
  const big = await findToast(t('web.upload.tooLarge', { size: '1.5 kB', max: '1 kB' }));
  expect(within(big).getByRole('alert')).toHaveTextContent(
    "This upload is 1.5 kB, over this Pinwall's limit of 1 kB per upload.",
  );

  dragAndDrop(fakeDrop([file('a.html'), file('b.css'), file('c.js')]));
  await findToast(t('web.upload.tooManyFiles', { max: '2' }));

  dragAndDrop(fakeDrop([dir('empty', [file('.DS_Store')])]));
  await findToast(t('web.upload.empty'));

  expect(state.uploads).toEqual([]);
});

test('a failed upload keeps its message until dismissed', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const message = '../x: path segments "." and ".." are not allowed.';
  serveLibrary({
    project: launchSite,
    respond: () => apiError(400, 'bad_request', message, { reason: 'dot_segment' }),
  });
  renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([site()]));
  const toast = await findToast(message);
  expect(within(toast).getByRole('alert')).toHaveTextContent(message);
  expect(within(toast).getByText(t('web.upload.failed', { name: 'site' }))).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(screen.getByText(message)).toBeInTheDocument();

  fireEvent.click(within(toast).getByRole('button', { name: t('web.common.close') }));
  await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
});

test('publish warnings are shown with the result', async () => {
  const warning = (file: string): PublishWarning => ({
    code: 'root_absolute_url',
    file,
    url: '/x.css',
    message: `${file} refers to /x.css …`,
  });
  serveLibrary({
    project: launchSite,
    respond: () =>
      HttpResponse.json(published({ warnings: [warning('index.html'), warning('about.html')] }), {
        status: 201,
      }),
  });
  renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([site()]));
  const toast = await findToast('Published “E2E Site” v1');
  expect(within(toast).getByText('index.html refers to /x.css …')).toBeInTheDocument();
  expect(within(toast).getByText(t('web.upload.moreWarnings', { count: 1 }))).toBeInTheDocument();
  expect(within(toast).queryByText('about.html refers to /x.css …')).not.toBeInTheDocument();
});

test('Cancel stops an upload and leaves no error behind', async () => {
  const state = serveLibrary({
    project: launchSite,
    respond: async () => {
      await delay(10_000);
      return HttpResponse.json(published(), { status: 201 });
    },
  });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([site()]));
  const toast = await findToast('site');
  expect(
    within(toast).getByRole('progressbar', {
      name: t('web.upload.progressLabel', { name: 'site' }),
    }),
  ).toBeInTheDocument();
  await waitFor(() => expect(state.uploads).toHaveLength(1));

  await user.click(within(toast).getByRole('button', { name: t('web.common.cancel') }));
  await waitFor(() => expect(toast).not.toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('the upload toast shows bytes sent and cancels', async () => {
  const store = createUploadStore({ phase: 'uploading', loaded: 0, total: 1_000 });
  const cancel = vi.fn();
  render(
    <UploadToast
      label="site"
      store={store}
      onCancel={cancel}
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  act(() => store.set({ phase: 'uploading', loaded: 400, total: 1_000 }));
  const bar = screen.getByRole('progressbar', {
    name: t('web.upload.progressLabel', { name: 'site' }),
  });
  expect(bar).toHaveAttribute('aria-valuenow', '40');
  expect(
    screen.getByText(t('web.upload.uploading', { loaded: '400 bytes', total: '1 kB' })),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: t('web.common.cancel') }));
  expect(cancel).toHaveBeenCalledOnce();

  act(() => store.set({ phase: 'processing', loaded: 1_000, total: 1_000 }));
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  expect(screen.queryByRole('button', { name: t('web.common.cancel') })).not.toBeInTheDocument();
});

test('upload is disabled in an archived project', async () => {
  const archived = fx.project({ id: 'prj_2', name: 'Launch site', archived_at: Date.now() });
  const state = serveLibrary({ project: archived });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  const upload = screen.getByRole('button', { name: t('web.upload.action') });
  expect(upload).toBeDisabled();
  expect(screen.getByRole('button', { name: t('web.upload.actionFiles') })).toBeDisabled();
  await user.hover(upload.parentElement as HTMLElement);
  expect(await screen.findByRole('tooltip')).toHaveTextContent(t('web.upload.archived'));

  // A drop says why and sends nothing; the browser does not open the file either.
  const dt = fakeDrop([site()]);
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  expect(screen.getAllByText(t('web.upload.archived')).length).toBeGreaterThan(0);
  expect(screen.queryByText(dropHere('Launch site'))).not.toBeInTheDocument();
  expect(fireEvent.drop(document.body, { dataTransfer: dt })).toBe(false);
  await act(() => delay(20));
  expect(state.uploads).toEqual([]);
});

test('the dialog picks files or a folder', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });
  const clicked = vi.spyOn(HTMLInputElement.prototype, 'click');
  onTestFinished(() => clicked.mockRestore());

  await user.click(screen.getByRole('button', { name: t('web.upload.action') }));
  let dialog = await screen.findByRole('dialog', {
    name: t('web.upload.title', { project: 'Launch site' }),
  });
  expect(within(dialog).getByText(t('web.upload.hint'))).toBeInTheDocument();
  expect(
    within(dialog).getByText(t('web.upload.limits', { size: '95 MB', count: '10,000' })),
  ).toBeInTheDocument();

  await user.click(within(dialog).getByRole('button', { name: t('web.upload.chooseFiles') }));
  const filesInput = clicked.mock.contexts.at(-1) as HTMLInputElement;
  expect(filesInput.type).toBe('file');
  expect(filesInput.multiple).toBe(true);
  expect(filesInput).not.toHaveAttribute('webkitdirectory');

  await user.click(within(dialog).getByRole('button', { name: t('web.upload.chooseFolder') }));
  const folderInput = clicked.mock.contexts.at(-1) as HTMLInputElement;
  expect(folderInput).toHaveAttribute('webkitdirectory');

  // The browser's file chooser fills the input without a pointer, even under the modal dialog.
  const chooser = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  await chooser.upload(folderInput, [folderFile('site/index.html'), folderFile('site/css/a.css')]);
  await findToast('Published “E2E Site” v1');
  expect(state.uploads.map((u) => u.paths)).toEqual([['site/css/a.css', 'site/index.html']]);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // Files: one archive goes up as an archive.
  await user.click(screen.getByRole('button', { name: t('web.upload.action') }));
  dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: t('web.upload.chooseFiles') }));
  await chooser.upload(filesInput, [new File(['PK'], 'site.zip')]);
  await waitFor(() => expect(state.uploads).toHaveLength(2));
  expect(state.uploads[1]).toEqual({
    target: '{"project_id":"prj_2"}',
    paths: [],
    files: ['site.zip'],
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('All artifacts publishes to the default project', async () => {
  const state = serveLibrary({});
  renderRoute('/', { me });
  expect(await screen.findByText(t('web.library.emptyTitle'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: t('web.upload.actionFiles') })).toBeEnabled();

  const dt = fakeDrop([file('index.html')]);
  fireEvent.dragEnter(document.body, { dataTransfer: dt });
  expect(await screen.findByText(dropHere('Default'))).toBeInTheDocument();
  fireEvent.drop(document.body, { dataTransfer: dt });

  await findToast('Published “E2E Site” v1');
  expect(state.uploads).toEqual([{ target: '{}', paths: ['index.html'], files: ['index.html'] }]);
  expect(await screen.findByRole('link', { name: 'E2E Site' })).toBeInTheDocument();
});
