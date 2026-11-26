import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import type { Project, PublicConfig, UpdateProjectRequest } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { serveArtifacts, serveSidebar } from '../../test/library.ts';
import { fxMember, serveMembers } from '../../test/members.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, server } from '../../test/server.ts';
import { BOB, fxOwn, fxShared, PERSONAL } from '../../test/spaces.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const EVERYONE: Partial<PublicConfig> = { ...PERSONAL, everyone_projects: true };
const ME = fx.me();

/**
 * Serves the project page of `project` (at `/projects/prj_1`), its members, and PATCHes of it,
 * which answer with the project as changed. Returns the PATCH bodies.
 */
function serveProject(project: Project, members = [fxMember()]) {
  let current = project;
  const patches: UpdateProjectRequest[] = [];
  serveSidebar({ projects: [project] });
  serveArtifacts(() => HttpResponse.json(fx.page([])));
  serveMembers({ projectId: project.id, members });
  server.use(
    http.get(`${API}/projects/${project.id}`, () => HttpResponse.json(current)),
    http.patch(`${API}/projects/${project.id}`, async ({ request }) => {
      const body = (await request.json()) as UpdateProjectRequest;
      patches.push(body);
      const on = body.visible_to_everyone === true;
      current = { ...current, visible_to_everyone: on, everyone_can_view: on };
      return HttpResponse.json(current);
    }),
  );
  return { patches };
}

async function openMembers(user: UserEvent, project: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: t('web.members.button') }));
  return screen.findByRole('dialog', { name: t('web.members.title', { project }) });
}

const everyoneSwitch = (dialog: HTMLElement) =>
  within(dialog).queryByRole('switch', { name: t('web.members.everyone.label') });

test('the owner lets everyone view a project, and stops it', async () => {
  const { patches } = serveProject(
    fxOwn({ id: 'prj_1', name: 'Handbook', visible_to_everyone: false, everyone_can_view: false }),
  );
  const { user } = renderRoute('/projects/prj_1', { config: EVERYONE });
  const dialog = await openMembers(user, 'Handbook');

  const toggle = await waitFor(() => {
    const found = everyoneSwitch(dialog);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
  expect(within(dialog).getByText(t('web.members.everyone.hint'))).toBeInTheDocument();

  await user.click(toggle);
  await waitFor(() => expect(patches).toEqual([{ visible_to_everyone: true }]));
  await waitFor(() => expect(toggle).toBeChecked());
  // The page says so too.
  expect(
    await screen.findByText(t('web.project.everyoneNote'), { exact: false }),
  ).toBeInTheDocument();

  await user.click(toggle);
  await waitFor(() =>
    expect(patches).toEqual([{ visible_to_everyone: true }, { visible_to_everyone: false }]),
  );
  await waitFor(() => expect(toggle).not.toBeChecked());
});

test('no switch where the Pinwall does not allow it, nor for anyone but the owner', async () => {
  serveProject(fxOwn({ id: 'prj_1', name: 'Handbook', visible_to_everyone: false }));
  const first = renderRoute('/projects/prj_1', { config: PERSONAL });
  let dialog = await openMembers(first.user, 'Handbook');
  await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
  expect(everyoneSwitch(dialog)).toBeNull();
  cleanup();

  serveProject(fxShared('editor', { id: 'prj_1', name: 'Handbook', everyone_can_view: false }));
  const second = renderRoute('/projects/prj_1', { config: EVERYONE });
  dialog = await openMembers(second.user, 'Handbook');
  await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
  expect(everyoneSwitch(dialog)).toBeNull();
});

test('an owner who may not make share links cannot turn it on, but can turn it off', async () => {
  serveProject(fxOwn({ id: 'prj_1', name: 'Handbook', visible_to_everyone: false }));
  const me = fx.me({ can_create_share_links: false });
  const first = renderRoute('/projects/prj_1', { config: EVERYONE, me });
  let dialog = await openMembers(first.user, 'Handbook');
  let toggle = await waitFor(() => everyoneSwitch(dialog) as HTMLElement);
  expect(toggle).toBeDisabled();
  expect(within(dialog).getByText(t('web.members.everyone.notApproved'))).toBeInTheDocument();
  cleanup();

  const { patches } = serveProject(
    fxOwn({ id: 'prj_1', name: 'Handbook', visible_to_everyone: true, everyone_can_view: false }),
  );
  const second = renderRoute('/projects/prj_1', { config: EVERYONE, me });
  dialog = await openMembers(second.user, 'Handbook');
  toggle = await waitFor(() => everyoneSwitch(dialog) as HTMLElement);
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  expect(within(dialog).getByText(t('web.members.everyone.paused'))).toBeInTheDocument();
  await second.user.click(toggle);
  await waitFor(() => expect(patches).toEqual([{ visible_to_everyone: false }]));
});

test('a default project cannot be visible to everyone', async () => {
  serveProject(
    fxOwn({ id: 'prj_1', name: 'Default', is_default: true, visible_to_everyone: false }),
  );
  const { user } = renderRoute('/projects/prj_1', { config: EVERYONE });
  const dialog = await openMembers(user, 'Default');
  const toggle = await waitFor(() => everyoneSwitch(dialog) as HTMLElement);
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();
  expect(within(dialog).getByText(t('web.members.everyone.default'))).toBeInTheDocument();
});

test('someone who sees a project because everyone may has no membership to leave', async () => {
  serveProject(fxShared('viewer', { id: 'prj_1', name: 'Handbook', everyone_can_view: true }));
  const first = renderRoute('/projects/prj_1', { config: EVERYONE });
  expect(
    await screen.findByText(
      `${t('web.project.sharedViewer', { owner: BOB.name })} · ${t('web.project.everyoneNote')}`,
    ),
  ).toBeInTheDocument();
  let dialog = await openMembers(first.user, 'Handbook');
  await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
  expect(within(dialog).getByText(t('web.members.everyone.viewerNote'))).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: t('web.members.leave') })).toBeNull();
  cleanup();

  // A member of such a project can still leave it.
  serveProject(fxShared('viewer', { id: 'prj_1', name: 'Handbook', everyone_can_view: true }), [
    fxMember({ user: { id: ME.id, name: ME.name, email: null } }),
  ]);
  const second = renderRoute('/projects/prj_1', { config: EVERYONE });
  dialog = await openMembers(second.user, 'Handbook');
  expect(
    await within(dialog).findByRole('button', { name: t('web.members.leave') }),
  ).toBeInTheDocument();
});

test("the sidebar lists others' projects for everyone under a heading of their own", async () => {
  const projects = [
    fxOwn({ id: 'prj_d', name: 'Default', is_default: true, everyone_can_view: false }),
    fxOwn({ id: 'prj_o', name: 'Onboarding', everyone_can_view: true, visible_to_everyone: true }),
    fxShared('editor', { id: 'prj_s', name: 'Pricing', everyone_can_view: false }),
    fxShared('viewer', { id: 'prj_e', name: 'Handbook', everyone_can_view: true }),
  ];
  serveSidebar({ projects });
  serveArtifacts(() => HttpResponse.json(fx.page([])));
  server.use(http.get(`${API}/projects`, () => HttpResponse.json(fx.page(projects))));
  renderRoute('/', { config: EVERYONE });

  const names = (label: string) =>
    within(screen.getByRole('list', { name: label }))
      .getAllByRole('link')
      .map((link) => link.textContent ?? '');
  await screen.findByRole('list', { name: t('web.sidebar.everyone') });
  expect(names(t('web.sidebar.projects'))).toEqual([
    'Default',
    `Onboarding${t('web.sidebar.visibleToEveryone')}`,
  ]);
  expect(names(t('web.sidebar.shared'))).toEqual([
    `Pricing${t('web.sidebar.sharedBy', { owner: BOB.name, role: t('web.role.editor') })}`,
  ]);
  expect(names(t('web.sidebar.everyone'))).toEqual([
    `Handbook${t('web.sidebar.sharedBy', { owner: BOB.name, role: t('web.role.viewer') })}`,
  ]);
});
