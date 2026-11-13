import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, test } from 'vitest';
import { ApiError } from '../../api/client.ts';
import type { MemberCandidate, Project } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { candidatesOf, memberErrorField } from '../../api/members.ts';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { serveArtifacts, serveSidebar } from '../../test/library.ts';
import { fxMember, serveMembers } from '../../test/members.ts';
import { renderRoute } from '../../test/render.tsx';
import { API, apiError, server } from '../../test/server.ts';
import { BOB, fxOwn, fxShared, PERSONAL } from '../../test/spaces.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const ME = fx.me();
const EVIL = '<img src=x onerror=alert(1)>';

/** The pages a project page asks for, with `project` as the one at `/projects/prj_1`. */
function serveProject(project: Project) {
  serveSidebar({ projects: [project] });
  serveArtifacts(() => HttpResponse.json(fx.page([])));
  server.use(http.get(`${API}/projects/${project.id}`, () => HttpResponse.json(project)));
}

/** Opens the Members dialog of the project page on screen. */
async function openMembers(user: UserEvent, project: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: t('web.members.button') }));
  return screen.findByRole('dialog', { name: t('web.members.title', { project }) });
}

const emailField = (dialog: HTMLElement) =>
  within(dialog).getByRole('textbox', { name: t('web.members.email') });

async function choose(user: UserEvent, field: HTMLElement, option: string | RegExp) {
  await user.click(field);
  await user.click(await screen.findByRole('option', { name: option }));
}

test('the Members button exists only in personal mode', async () => {
  const asked: string[] = [];
  server.use(
    http.get(`${API}/projects/prj_1/members`, ({ request }) => {
      asked.push(request.url);
      return HttpResponse.json({ items: [] });
    }),
  );
  serveProject(fx.project({ id: 'prj_1', name: 'Launch' }));
  renderRoute('/projects/prj_1');

  await screen.findByRole('heading', { level: 1, name: 'Launch' });
  expect(screen.queryByRole('button', { name: t('web.members.button') })).not.toBeInTheDocument();
  expect(asked).toEqual([]);

  cleanup();
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  renderRoute('/projects/prj_1', { config: PERSONAL });
  expect(await screen.findByRole('button', { name: t('web.members.button') })).toBeInTheDocument();
  // Reading the members waits for the dialog.
  expect(asked).toEqual([]);
});

test('every role sees the Members button in personal mode', async () => {
  serveProject(fxShared('viewer', { id: 'prj_1', name: 'Pricing' }));
  renderRoute('/projects/prj_1', { config: PERSONAL });

  expect(await screen.findByRole('button', { name: t('web.members.button') })).toBeInTheDocument();
});

test('the owner sees members with emails, changes a role and removes someone', async () => {
  const { calls } = serveMembers({ projectId: 'prj_1', members: [fxMember()] });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');

  // The owner comes first, then the members.
  const list = await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
  const [owner, grace, ...rest] = within(list).getAllByRole('listitem');
  expect(rest).toEqual([]);
  expect(within(owner as HTMLElement).getByText('Ada Lovelace')).toBeInTheDocument();
  expect(within(owner as HTMLElement).getByText(t('web.role.owner'))).toBeInTheDocument();
  expect(within(owner as HTMLElement).getByText(t('web.members.you'))).toBeInTheDocument();
  expect(within(grace as HTMLElement).getByText('Grace Hopper')).toBeInTheDocument();
  expect(within(grace as HTMLElement).getByText('grace@example.com')).toBeInTheDocument();
  expect(within(grace as HTMLElement).queryByText(t('web.members.you'))).not.toBeInTheDocument();
  expect(within(dialog).queryByText(t('web.members.memberHint'))).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: t('web.members.leave') }),
  ).not.toBeInTheDocument();

  const role = within(dialog).getByRole('combobox', {
    name: t('web.members.roleFor', { name: 'Grace Hopper' }),
  });
  expect(role).toHaveTextContent(t('web.role.viewer'));
  await choose(user, role, t('web.role.editor'));
  await waitFor(() =>
    expect(calls).toEqual([
      { method: 'PATCH', path: '/projects/prj_1/members/usr_2', body: { role: 'editor' } },
    ]),
  );
  await waitFor(() => expect(role).toHaveTextContent(t('web.role.editor')));

  await user.click(
    within(dialog).getByRole('button', {
      name: t('web.members.removeFor', { name: 'Grace Hopper' }),
    }),
  );
  const confirm = await screen.findByRole('alertdialog', { name: t('web.members.remove.title') });
  expect(
    within(confirm).getByText(
      t('web.members.remove.body', { name: 'Grace Hopper', project: 'Launch' }),
    ),
  ).toBeInTheDocument();
  await user.click(within(confirm).getByRole('button', { name: t('web.members.remove.confirm') }));

  await waitFor(() =>
    expect(calls.at(-1)).toEqual({
      method: 'DELETE',
      path: '/projects/prj_1/members/usr_2',
      body: undefined,
    }),
  );
  // The list is read again: Grace is gone.
  expect(await within(dialog).findByText(t('web.members.empty'))).toBeInTheDocument();
  expect(within(dialog).queryByText('Grace Hopper')).not.toBeInTheDocument();
});

test('the owner adds by email with a role', async () => {
  const { calls } = serveMembers({
    projectId: 'prj_1',
    members: [],
    add: () => HttpResponse.json(fxMember({ role: 'editor' }), { status: 201 }),
  });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');

  expect(await within(dialog).findByText(t('web.members.empty'))).toBeInTheDocument();
  expect(within(dialog).getByText(t('web.members.hint'))).toBeInTheDocument();
  const role = within(dialog).getByRole('combobox', { name: t('web.members.role') });
  // Viewers can only read and comment, so it is the choice to start from.
  expect(role).toHaveTextContent(t('web.role.viewer'));
  expect(emailField(dialog)).toHaveAttribute('type', 'email');

  await user.type(emailField(dialog), 'grace@example.com');
  await choose(user, role, t('web.role.editor'));
  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));

  expect(await within(dialog).findByText('Grace Hopper')).toBeInTheDocument();
  expect(calls).toEqual([
    {
      method: 'POST',
      path: '/projects/prj_1/members',
      body: { email: 'grace@example.com', role: 'editor' },
    },
  ]);
  expect(within(dialog).queryByText(t('web.members.empty'))).not.toBeInTheDocument();
  // Ready for the next person, with the safer role.
  expect(emailField(dialog)).toHaveValue('');
  expect(role).toHaveTextContent(t('web.role.viewer'));
});

test('an address that is not an email is refused before anything is sent', async () => {
  const { calls } = serveMembers({ projectId: 'prj_1', members: [] });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');
  await within(dialog).findByText(t('web.members.empty'));

  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));
  expect(await within(dialog).findByText(t('web.members.emailInvalid'))).toBeInTheDocument();
  await user.type(emailField(dialog), 'not an email');
  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));
  expect(within(dialog).getByText(t('web.members.emailInvalid'))).toBeInTheDocument();
  expect(emailField(dialog)).toHaveFocus();
  expect(calls).toEqual([]);
});

const GRACE_ACCOUNTS: MemberCandidate[] = [
  { user_id: 'usr_5', name: 'Grace', kind: 'owner' },
  { user_id: 'usr_6', name: 'Grace Hopper', kind: 'oidc' },
];

/** Refuses an add that names no account, as the server does when several use the email. */
const severalAccounts = (body: { email: string; role: 'editor' | 'viewer'; user_id?: string }) =>
  body.user_id === undefined
    ? apiError(409, 'conflict', t('spaces.members.severalAccounts'), {
        reason: 'several_accounts',
        candidates: GRACE_ACCOUNTS,
      })
    : HttpResponse.json(
        fxMember({
          user: { id: body.user_id, name: 'Grace Hopper', email: body.email },
          role: body.role,
        }),
        { status: 201 },
      );

test('several accounts share the email: the owner picks one and only that one is added', async () => {
  const { calls } = serveMembers({ projectId: 'prj_1', members: [], add: severalAccounts });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');
  await within(dialog).findByText(t('web.members.empty'));

  await user.type(emailField(dialog), 'grace@example.com');
  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));

  const account = await within(dialog).findByRole('combobox', {
    name: t('web.members.chooseAccount'),
  });
  expect(within(dialog).getByText(t('spaces.members.severalAccounts'))).toBeInTheDocument();
  // Nothing was added, and nothing is picked for the owner.
  expect(within(dialog).queryByRole('listitem', { name: /Grace/ })).not.toBeInTheDocument();

  await user.click(account);
  const both = await screen.findAllByRole('option');
  expect(both.map((option) => option.textContent)).toEqual([
    `Grace${t('web.members.kind.owner')}`,
    `Grace Hopper${t('web.members.kind.oidc')}`,
  ]);
  await user.click(screen.getByRole('option', { name: /^Grace Hopper/ }));
  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));

  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls.map((call) => call.body)).toEqual([
    { email: 'grace@example.com', role: 'viewer' },
    { email: 'grace@example.com', role: 'viewer', user_id: 'usr_6' },
  ]);
  const list = await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
  expect(within(list).getAllByText('Grace Hopper')).toHaveLength(1);
  // The choice is gone with the answer.
  expect(
    within(dialog).queryByRole('combobox', { name: t('web.members.chooseAccount') }),
  ).not.toBeInTheDocument();
  expect(emailField(dialog)).toHaveValue('');
});

test('Add waits for the owner to choose among the accounts', async () => {
  const { calls } = serveMembers({ projectId: 'prj_1', members: [], add: severalAccounts });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');
  await within(dialog).findByText(t('web.members.empty'));

  await user.type(emailField(dialog), 'grace@example.com');
  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));
  const account = await within(dialog).findByRole('combobox', {
    name: t('web.members.chooseAccount'),
  });

  // The message above the choice says why; no account is picked for the owner.
  const add = within(dialog).getByRole('button', { name: t('web.members.add') });
  expect(add).toBeDisabled();
  await choose(user, account, /^Grace Hopper/);
  expect(add).toBeEnabled();
  expect(calls).toHaveLength(1);
});

test('editing the email clears the choice of account', async () => {
  serveMembers({ projectId: 'prj_1', members: [], add: severalAccounts });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');
  await within(dialog).findByText(t('web.members.empty'));

  await user.type(emailField(dialog), 'grace@example.com');
  await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));
  const account = await within(dialog).findByRole('combobox', {
    name: t('web.members.chooseAccount'),
  });
  await choose(user, account, /^Grace Hopper/);
  expect(account).toHaveTextContent('Grace Hopper');

  await user.type(emailField(dialog), 'x');
  expect(
    within(dialog).queryByRole('combobox', { name: t('web.members.chooseAccount') }),
  ).not.toBeInTheDocument();
});

const REFUSALS = [
  {
    name: 'no account',
    answer: () => apiError(404, 'not_found', t('spaces.members.noAccount'), { field: 'email' }),
    message: t('spaces.members.noAccount'),
    under: 'email',
  },
  {
    name: 'the owner picked themselves',
    answer: () => apiError(400, 'bad_request', t('spaces.members.self'), { field: 'email' }),
    message: t('spaces.members.self'),
    under: 'email',
  },
  {
    name: 'already a member',
    answer: () =>
      apiError(409, 'conflict', t('spaces.members.already'), { reason: 'already_member' }),
    message: t('spaces.members.already'),
    under: 'email',
  },
  {
    name: 'not the owner',
    answer: () => apiError(403, 'forbidden', t('spaces.role.manageMembers'), { reason: 'role' }),
    message: t('spaces.role.manageMembers'),
    under: 'form',
  },
  {
    name: 'too many attempts',
    answer: () => apiError(429, 'rate_limited', 'Too many attempts. Try again in an hour.'),
    message: 'Too many attempts. Try again in an hour.',
    under: 'form',
  },
  {
    name: 'the project is gone',
    answer: () => apiError(404, 'not_found', 'No such project.'),
    message: 'No such project.',
    under: 'form',
  },
] as const;

test.each(REFUSALS)(
  "refusals show the server's words where they belong: $name",
  async ({ answer, message, under }) => {
    serveMembers({ projectId: 'prj_1', members: [], add: answer });
    serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
    const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
    const dialog = await openMembers(user, 'Launch');
    await within(dialog).findByText(t('web.members.empty'));

    await user.type(emailField(dialog), 'grace@example.com');
    await user.click(within(dialog).getByRole('button', { name: t('web.members.add') }));

    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(within(dialog).getAllByText(message)).toHaveLength(1);
    if (under === 'email') {
      expect(emailField(dialog)).toHaveAttribute('aria-invalid', 'true');
      expect(emailField(dialog)).toHaveAccessibleDescription(expect.stringContaining(message));
    } else {
      expect(emailField(dialog)).not.toHaveAttribute('aria-invalid');
      expect(emailField(dialog)).not.toHaveAccessibleDescription(expect.stringContaining(message));
    }
    // The address stays for a fix, and typing again takes the refusal away.
    expect(emailField(dialog)).toHaveValue('grace@example.com');
    await user.type(emailField(dialog), 'm');
    if (under === 'email') {
      await waitFor(() => expect(within(dialog).queryByText(message)).not.toBeInTheDocument());
    }
  },
);

test.each(['viewer', 'editor'] as const)(
  'members see names only and can leave: %s',
  async (role) => {
    const { calls } = serveMembers({
      projectId: 'prj_1',
      members: [
        fxMember({ user: { id: 'usr_2', name: 'Grace Hopper', email: null } }),
        fxMember({ user: { id: ME.id, name: ME.name, email: null }, role }),
      ],
    });
    const project = fxShared(role, { id: 'prj_1', name: 'Pricing' });
    serveProject(project);
    let projectReads = 0;
    server.use(
      http.get(`${API}/projects/prj_1`, () => {
        projectReads += 1;
        return HttpResponse.json(project);
      }),
    );
    const { user, router, queryClient } = renderRoute('/projects/prj_1', { config: PERSONAL });
    const dialog = await openMembers(user, 'Pricing');

    const list = await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
    const rows = within(list).getAllByRole('listitem');
    // What each row says, without its avatar's initials.
    const words = (row: HTMLElement) => {
      const copy = row.cloneNode(true) as HTMLElement;
      for (const decoration of copy.querySelectorAll('[aria-hidden]')) decoration.remove();
      return copy.textContent;
    };
    expect(rows.map(words)).toEqual([
      `${BOB.name}${t('web.role.owner')}`,
      'Grace Hopper',
      `${ME.name}${t('web.members.you')}`,
    ]);
    expect(within(dialog).getByText(t('web.members.memberHint'))).toBeInTheDocument();
    expect(within(dialog).queryByText(/@/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: t('web.members.add') }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: t('web.members.leave') }));
    const confirm = await screen.findByRole('alertdialog', { name: t('web.members.leave.title') });
    expect(within(confirm).getByText(t('web.members.leave.body'))).toBeInTheDocument();
    const readsBefore = projectReads;
    await user.click(within(confirm).getByRole('button', { name: t('web.members.leave') }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls).toEqual([
      { method: 'DELETE', path: `/projects/prj_1/members/${ME.id}`, body: undefined },
    ]);
    expect(
      await screen.findByText(t('web.members.left', { project: 'Pricing' })),
    ).toBeInTheDocument();
    // What the cache held about the project goes, and the page left behind does not ask for it again.
    expect(queryClient.getQueryData(qk.project('prj_1'))).toBeUndefined();
    expect(queryClient.getQueryData(qk.members('prj_1'))).toBeUndefined();
    expect(projectReads).toBe(readsBefore);
  },
);

test("leaving forgets what the cache holds about the project's artifacts, and only those", async () => {
  serveMembers({
    projectId: 'prj_1',
    members: [fxMember({ user: { id: ME.id, name: ME.name, email: null }, role: 'editor' })],
  });
  serveProject(fxShared('editor', { id: 'prj_1', name: 'Pricing' }));
  const { user, router, queryClient } = renderRoute('/projects/prj_1', { config: PERSONAL });
  /** Every key a review of artifact `id` fills: what Back would paint from before reading. */
  const keysOf = (id: string) => [
    qk.artifact(id),
    qk.versions(id),
    qk.version(id, 1),
    qk.preview(id, 1, 'review'),
    qk.threads({ kind: 'artifact', artifactId: id }),
    qk.shareLinks(id),
    qk.diff(id, 1, 2),
    qk.fileDiff(id, 1, 2, 'index.html'),
  ];
  // An artifact of the project, and one of another project, each reviewed before.
  for (const artifact of [
    fx.artifact({ id: 'art_in', project_id: 'prj_1' }),
    fx.artifact({ id: 'art_out', project_id: 'prj_9' }),
  ]) {
    const [summary, ...rest] = keysOf(artifact.id);
    queryClient.setQueryData(summary as readonly unknown[], artifact);
    for (const key of rest) queryClient.setQueryData(key, { cached: artifact.id });
  }

  const dialog = await openMembers(user, 'Pricing');
  await user.click(await within(dialog).findByRole('button', { name: t('web.members.leave') }));
  const confirm = await screen.findByRole('alertdialog', { name: t('web.members.leave.title') });
  await user.click(within(confirm).getByRole('button', { name: t('web.members.leave') }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/'));

  for (const key of keysOf('art_in')) {
    expect(queryClient.getQueryData(key), key.join(' ')).toBeUndefined();
  }
  for (const key of keysOf('art_out')) {
    expect(queryClient.getQueryData(key), key.join(' ')).toBeDefined();
  }
});

test('a failed leave says why and keeps the person in', async () => {
  serveMembers({ projectId: 'prj_1', members: [fxMember()] });
  serveProject(fxShared('viewer', { id: 'prj_1', name: 'Pricing' }));
  server.use(
    http.delete(`${API}/projects/prj_1/members/${ME.id}`, () =>
      apiError(404, 'not_found', 'This person is not a member of this project.'),
    ),
  );
  const { user, router } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Pricing');

  await user.click(await within(dialog).findByRole('button', { name: t('web.members.leave') }));
  const confirm = await screen.findByRole('alertdialog');
  await user.click(within(confirm).getByRole('button', { name: t('web.members.leave') }));

  expect(
    await within(confirm).findByText('This person is not a member of this project.'),
  ).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/projects/prj_1');
});

test.each([
  ['a member', 'owner'],
  ['the owner of the project', 'viewer'],
] as const)('names render as text: %s', async (_who, role) => {
  const evil = { id: 'usr_9', name: EVIL, email: `${EVIL}@example.com` };
  const project =
    role === 'owner'
      ? fxOwn({ id: 'prj_1', name: 'Launch' })
      : fxShared('viewer', { id: 'prj_1', name: 'Launch', owner: { id: BOB.id, name: EVIL } });
  serveMembers({
    projectId: 'prj_1',
    members: [
      fxMember({ user: role === 'owner' ? evil : { ...evil, name: 'Grace', email: null } }),
    ],
  });
  serveProject(project);
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');

  await within(dialog).findByRole('list', { name: t('web.members.listLabel') });
  expect(within(dialog).getByText(EVIL)).toBeInTheDocument();
  if (role === 'owner') {
    expect(within(dialog).getByText(`${EVIL}@example.com`)).toBeInTheDocument();
  }
  expect(dialog.querySelector('img')).toBeNull();
});

test('a member without a name is called what it is', async () => {
  serveMembers({
    projectId: 'prj_1',
    members: [fxMember({ user: { id: 'usr_2', name: null, email: 'someone@example.com' } })],
  });
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');

  expect(await within(dialog).findByText(t('web.members.unnamed'))).toBeInTheDocument();
  expect(within(dialog).getByText('someone@example.com')).toBeInTheDocument();
  expect(
    within(dialog).getByRole('button', {
      name: t('web.members.removeFor', { name: t('web.members.unnamed') }),
    }),
  ).toBeInTheDocument();
});

test('members list states', async () => {
  let answer: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let reads = 0;
  server.use(
    http.get(`${API}/projects/prj_1/members`, async () => {
      reads += 1;
      if (reads > 1) return HttpResponse.json({ items: [fxMember()] });
      await gate;
      return apiError(500, 'internal', 'The server broke.');
    }),
  );
  serveProject(fxOwn({ id: 'prj_1', name: 'Launch' }));
  const { user } = renderRoute('/projects/prj_1', { config: PERSONAL });
  const dialog = await openMembers(user, 'Launch');

  expect(
    await within(dialog).findByRole('status', { name: t('web.members.loading') }),
  ).toBeInTheDocument();
  // No form while the list is not known.
  expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();

  answer();
  expect(await within(dialog).findByText('The server broke.')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: t('web.common.retry') }));
  expect(await within(dialog).findByText('Grace Hopper')).toBeInTheDocument();
  expect(emailField(dialog)).toBeInTheDocument();
});

test('refusals are read only for what they say', () => {
  const refusal = (status: number, details?: Record<string, unknown>) =>
    new ApiError(status, 'refused', 'No.', details);

  expect(
    candidatesOf(refusal(409, { reason: 'several_accounts', candidates: GRACE_ACCOUNTS })),
  ).toEqual(GRACE_ACCOUNTS);
  expect(candidatesOf(refusal(409, { reason: 'already_member' }))).toBeNull();
  expect(candidatesOf(refusal(409, { reason: 'several_accounts' }))).toBeNull();
  expect(
    candidatesOf(refusal(409, { reason: 'several_accounts', candidates: [{ user_id: 7 }] })),
  ).toBeNull();
  expect(candidatesOf(new Error('boom'))).toBeNull();

  expect(memberErrorField(refusal(404, { field: 'email' }))).toBe('email');
  expect(memberErrorField(refusal(400, { field: 'email' }))).toBe('email');
  expect(memberErrorField(refusal(409, { reason: 'already_member' }))).toBe('email');
  // Not about the address: a missing project, a role, an hour's limit, several accounts.
  expect(memberErrorField(refusal(404))).toBeNull();
  expect(memberErrorField(refusal(400, { field: 'role' }))).toBeNull();
  expect(memberErrorField(refusal(403, { reason: 'role' }))).toBeNull();
  expect(memberErrorField(refusal(429))).toBeNull();
  expect(memberErrorField(refusal(409, { reason: 'several_accounts' }))).toBeNull();
  expect(memberErrorField(new Error('boom'))).toBeNull();
});
