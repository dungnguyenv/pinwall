import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { delay, HttpResponse, http } from 'msw';
import { expect, onTestFinished, test, vi } from 'vitest';
import type { ArtifactSummary, Project, PublishResult, PublishWarning } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { formatBytes } from '../../lib/format.ts';
import { sendUpload, type UploadProgress } from '../../lib/upload/send.ts';
import { dir, fakeDrop, file, folderFile } from '../../test/fake-entries.ts';
import { fx } from '../../test/fixtures.ts';
import { artifactLink, serveArtifacts, serveSidebar } from '../../test/library.ts';
import { formParts } from '../../test/multipart.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { createUploadStore, UploadToast } from './upload-toast.tsx';

// Calls through to the real thing; one test replaces it to hold an upload between phases.
vi.mock('../../lib/upload/send.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/upload/send.ts')>();
  return { ...actual, sendUpload: vi.fn(actual.sendUpload) };
});

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
  const state: { artifacts: ArtifactSummary[]; uploads: SentUpload[] } = {
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
  expect(await screen.findByRole('link', { name: artifactLink('E2E Site') })).toHaveAttribute(
    'href',
    '/a/art_9',
  );
  expect(screen.queryByText(dropHere('Launch site'))).not.toBeInTheDocument();

  const open = within(toast).getByRole('link', { name: 'Open' });
  expect(open).toHaveAttribute('href', '/a/art_9');
  await user.click(open);
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_9'));
});

const hiddenTitle = () => t('web.upload.hiddenTitle');

test('version-control folders are never sent, and the toast says how many files stayed behind', async () => {
  const state = serveLibrary({ project: launchSite });
  renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(
    fakeDrop([
      dir('site', [
        file('index.html'),
        dir('.git', [file('config'), dir('objects', [file('ab12'), file('cd34')])]),
        dir('.svn', [file('entries')]),
      ]),
    ]),
  );

  const toast = await findToast('Published “E2E Site” v1');
  expect(within(toast).getByText(t('web.upload.skippedVcs', { count: 4 }))).toBeInTheDocument();
  expect(state.uploads.map((u) => u.paths)).toEqual([['site/index.html']]);
  // Nothing hidden is left to ask about.
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('hidden files are listed before sending, and skipping them is the default', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(
    fakeDrop([
      dir('site', [
        file('index.html'),
        file('.env'),
        dir('.well-known', [file('security.txt')]),
        dir('.git', [file('config')]),
      ]),
    ]),
  );

  const dialog = await screen.findByRole('dialog', { name: hiddenTitle() });
  expect(within(dialog).getByText(t('web.upload.hiddenBody', { count: 2 }))).toBeInTheDocument();
  const listed = within(within(dialog).getByRole('list', { name: t('web.upload.hiddenList') }));
  expect(listed.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'site/.env',
    'site/.well-known/security.txt',
  ]);
  // Nothing has left the browser, and the safe answer has the focus.
  expect(state.uploads).toEqual([]);
  const skip = within(dialog).getByRole('button', { name: t('web.upload.hiddenSkip') });
  expect(skip).toHaveFocus();

  await user.click(skip);
  const toast = await findToast('Published “E2E Site” v1');
  expect(state.uploads.map((u) => u.paths)).toEqual([['site/index.html']]);
  expect(
    within(toast).getByText(
      `${t('web.upload.skippedVcs', { count: 1 })} ${t('web.upload.skippedHidden', { count: 2 })}`,
    ),
  ).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('"Include them" sends the hidden files too', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([dir('site', [file('index.html'), file('.htaccess')])]));
  const dialog = await screen.findByRole('dialog', { name: hiddenTitle() });
  await user.click(within(dialog).getByRole('button', { name: t('web.upload.hiddenInclude') }));

  const toast = await findToast('Published “E2E Site” v1');
  expect(state.uploads.map((u) => u.paths)).toEqual([['site/.htaccess', 'site/index.html']]);
  expect(within(toast).queryByText(/left out/)).not.toBeInTheDocument();
});

test('closing the hidden files question sends nothing', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([dir('site', [file('index.html'), file('.env')])]));
  await screen.findByRole('dialog', { name: hiddenTitle() });
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await act(() => delay(20));
  expect(state.uploads).toEqual([]);
  expect(document.querySelector('[data-sonner-toast]')).toBeNull();
});

test('a selection of only hidden files has nothing to send once they are skipped', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([file('.env'), file('.npmrc')]));
  const dialog = await screen.findByRole('dialog', { name: hiddenTitle() });
  await user.click(within(dialog).getByRole('button', { name: t('web.upload.hiddenSkip') }));

  const toast = await findToast(t('web.upload.empty'));
  expect(within(toast).getByText(t('web.upload.skippedHidden', { count: 2 }))).toBeInTheDocument();
  expect(state.uploads).toEqual([]);
});

test('many hidden files are listed in part, and the folder picker asks too', async () => {
  const state = serveLibrary({ project: launchSite });
  const { user } = renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });
  const clicked = vi.spyOn(HTMLInputElement.prototype, 'click');
  onTestFinished(() => clicked.mockRestore());

  await user.click(screen.getByRole('button', { name: t('web.upload.action') }));
  const picker = await screen.findByRole('dialog', {
    name: t('web.upload.title', { project: 'Launch site' }),
  });
  await user.click(within(picker).getByRole('button', { name: t('web.upload.chooseFolder') }));
  const folderInput = clicked.mock.contexts.at(-1) as HTMLInputElement;

  const chooser = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  const many = Array.from({ length: 11 }, (_, i) => folderFile(`site/.d/f${i}.txt`));
  await chooser.upload(folderInput, [
    folderFile('site/index.html'),
    folderFile('site/.git/config'),
    ...many,
  ]);

  const dialog = await screen.findByRole('dialog', { name: hiddenTitle() });
  const items = within(dialog).getAllByRole('listitem');
  expect(items).toHaveLength(9);
  expect(items.at(-1)).toHaveTextContent(t('web.upload.hiddenMore', { count: 3 }));
  expect(state.uploads).toEqual([]);

  await user.click(within(dialog).getByRole('button', { name: t('web.upload.hiddenSkip') }));
  await findToast('Published “E2E Site” v1');
  expect(state.uploads.map((u) => u.paths)).toEqual([['site/index.html']]);
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
  expect(
    within(big).getByText("This upload is 1.5 kB, over this Pinwall's limit of 1 kB per upload."),
  ).toBeInTheDocument();

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
  expect(within(toast).getByText(t('web.upload.failed', { name: 'site' }))).toBeInTheDocument();
  // The toast sits in sonner's live region, which already announces it; an alert inside would read it twice.
  expect(within(toast).queryByRole('alert')).not.toBeInTheDocument();

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

/**
 * What a screen reader can read in `root`: its text, minus whatever is hidden
 * from assistive technology.
 */
function announcedText(root: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement) || node.getAttribute('aria-hidden') === 'true') return '';
    return Array.from(node.childNodes).map(read).join(' ');
  };
  return read(root).replace(/\s+/g, ' ').trim();
}

test('byte progress stays visible but is not read out; only phase changes are', () => {
  const store = createUploadStore({ phase: 'preparing' });
  const { container } = render(
    <UploadToast
      label="site"
      store={store}
      onCancel={() => {}}
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  const heard = () => announcedText(container);
  expect(heard()).toContain(t('web.upload.phasePreparing', { name: 'site' }));
  expect(screen.getByText(t('web.upload.preparing'))).toBeInTheDocument();

  act(() => store.set({ phase: 'uploading', loaded: 0, total: 1_000_000 }));
  const uploading = heard();
  expect(uploading).toContain(t('web.upload.phaseUploading', { name: 'site' }));
  expect(uploading).not.toContain(t('web.upload.phasePreparing', { name: 'site' }));
  expect(uploading).not.toMatch(/bytes|kB|MB/);

  // Every step of the progress is on screen, and none of it changes what is heard.
  for (const loaded of [1_000, 50_000, 400_000, 999_000]) {
    act(() => store.set({ phase: 'uploading', loaded, total: 1_000_000 }));
    const visible = screen.getByText(
      t('web.upload.uploading', { loaded: formatBytes(loaded), total: '1 MB' }),
    );
    expect(visible).toBeVisible();
    expect(visible.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(heard()).toBe(uploading);
  }

  act(() => store.set({ phase: 'processing', loaded: 1_000_000, total: 1_000_000 }));
  expect(heard()).toContain(t('web.upload.phasePublishing', { name: 'site' }));
  expect(heard()).not.toContain(t('web.upload.phaseUploading', { name: 'site' }));
  expect(screen.getByText(t('web.upload.processing'))).toBeInTheDocument();

  act(() =>
    store.set({
      phase: 'published',
      name: 'E2E Site',
      number: 3,
      href: '/a/art_9',
      warnings: [],
    }),
  );
  expect(heard()).toContain('Published “E2E Site” v3');

  act(() => store.set({ phase: 'failed', message: 'The server said no.' }));
  expect(heard()).toContain(t('web.upload.failed', { name: 'site' }));
  expect(heard()).toContain('The server said no.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an upload is preparing until the first byte goes, then uploading, then publishing', async () => {
  const state = serveLibrary({ project: launchSite });
  // The request is held back so the toast can be read between its phases.
  let report: (p: UploadProgress) => void = () => {};
  let finish: (result: PublishResult) => void = () => {};
  vi.mocked(sendUpload).mockImplementationOnce((_form, o) => {
    report = (p) => o.onProgress?.(p);
    return new Promise<PublishResult>((resolve) => {
      finish = resolve;
    });
  });
  renderRoute('/projects/prj_2', { me });
  await screen.findByRole('heading', { level: 1, name: 'Launch site' });

  dragAndDrop(fakeDrop([site()]));
  const toast = await findToast('site');
  expect(announcedText(toast)).toContain(t('web.upload.phasePreparing', { name: 'site' }));
  expect(within(toast).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

  act(() => report({ phase: 'uploading', loaded: 10, total: 100 }));
  expect(announcedText(toast)).toContain(t('web.upload.phaseUploading', { name: 'site' }));
  expect(announcedText(toast)).not.toContain(t('web.upload.phasePreparing', { name: 'site' }));

  act(() => report({ phase: 'processing', loaded: 100, total: 100 }));
  expect(announcedText(toast)).toContain(t('web.upload.phasePublishing', { name: 'site' }));

  await act(async () => finish(published()));
  expect(await findToast('Published “E2E Site” v1')).toBeInTheDocument();
  expect(state.uploads).toEqual([]);
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
  expect(await screen.findByRole('link', { name: artifactLink('E2E Site') })).toBeInTheDocument();
});
