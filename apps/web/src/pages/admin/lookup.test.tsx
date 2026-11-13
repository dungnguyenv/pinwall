import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { beforeEach, expect, test } from 'vitest';
import i18n from '../../i18n.ts';
import {
  fxAdminConfig,
  fxAdminPerson,
  fxAdminShareLink,
  fxAdminUser,
  fxLookup,
  fxOwnerRow,
  serveAdminConfig,
  serveAdminUsers,
  serveModeration,
} from '../../test/admin.ts';
import { fx } from '../../test/fixtures.ts';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { apiError } from '../../test/server.ts';

const t = i18n.t.bind(i18n);
const HOUR = 3_600_000;
const DAY = 86_400_000;

type User = ReturnType<typeof renderRoute>['user'];

beforeEach(() => {
  serveSidebar();
  setViewport(1600);
});

const SHARE_URL = 'https://pinwall.test/s/abc';
const CAROL = fxAdminPerson({ id: 'usr_c', name: 'Carol Example', email: 'carol@example.test' });
const EVE = fxAdminPerson({ id: 'usr_e', name: 'Eve Example', email: 'eve@example.test' });

/** The result of a look-up, whatever its kind; `null` before there is one. */
const resultRegion = () =>
  screen.queryByRole('region', { name: /^(Share link|Content address|Artifact link)$/ });

/** Types an address into the form and looks it up; resolves with the result region of `kind`. */
async function lookUp(user: User, address = SHARE_URL, kind = 'Share link') {
  const field = await screen.findByRole('textbox', { name: 'Reported address' });
  await user.clear(field);
  await user.type(field, address);
  await user.click(screen.getByRole('button', { name: 'Look up' }));
  return within(await screen.findByRole('region', { name: kind }));
}

/** The text of the value that goes with `label` inside `scope`. */
function fact(scope: ReturnType<typeof within>, label: string): string {
  const term = scope.getByText(label, { selector: 'dt' });
  return term.parentElement?.querySelector('dd')?.textContent ?? '';
}

/**
 * Presses a takedown button and confirms its dialog. `sent` counts what reached the server; the
 * dialog must open without sending anything.
 */
async function takeDown(
  user: User,
  sent: () => number,
  action: string,
  confirm: string,
): Promise<void> {
  const before = sent();
  await user.click(screen.getByRole('button', { name: action }));
  const dialog = within(await screen.findByRole('alertdialog'));
  expect(sent()).toBe(before);
  await user.click(dialog.getByRole('button', { name: confirm }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(sent()).toBeGreaterThan(before);
}

test('a share URL names the artifact, owner, version and link', async () => {
  const { calls } = serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          share_link: fxAdminShareLink({
            created_by: CAROL,
            has_password: true,
            allow_comments: true,
            expires_at: Date.now() + 3 * DAY + HOUR,
            last_used_at: Date.now() - 2 * HOUR,
          }),
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  expect(await screen.findByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe('Look up a link · Pinwall'));
  expect(
    screen.getByText(
      'Paste an address from an abuse report: a share link, an artifact link, or a content address. You see whose it is and what it points to, not its content.',
    ),
  ).toBeInTheDocument();
  // Nothing is shown before a look-up.
  expect(resultRegion()).not.toBeInTheDocument();

  const result = await lookUp(user);
  expect(calls).toEqual([{ method: 'POST', path: '/admin/lookup', body: { url: SHARE_URL } }]);

  const what = within(result.getByRole('group', { name: 'What it points to' }));
  expect(fact(what, 'Artifact')).toBe('Pricing');
  expect(fact(what, 'Project')).toBe('Website');
  expect(fact(what, 'Owner')).toBe('Bob Examplebob@example.test');
  expect(fact(what, 'Version')).toBe('v2');
  expect(fact(what, 'Published by')).toBe('Bob Examplebob@example.test');

  const link = within(result.getByRole('group', { name: 'The share link' }));
  expect(fact(link, 'Shows')).toBe('Latest version');
  expect(fact(link, 'Made by')).toBe('Carol Examplecarol@example.test');
  expect(fact(link, 'Created')).toBe('Nov 1, 2026');
  expect(fact(link, 'Expires')).toBe('in 3 days');
  expect(fact(link, 'Password')).toBe('Yes');
  expect(fact(link, 'Comments')).toBe('Allowed');
  expect(fact(link, 'Last used')).toBe('2 hours ago');
  // A share URL has no grant.
  expect(result.queryByRole('group', { name: 'The open page' })).not.toBeInTheDocument();
});

test('a link that never expires or was never used says so', async () => {
  serveModeration({ lookup: () => HttpResponse.json(fxLookup()) });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user);
  const link = within(result.getByRole('group', { name: 'The share link' }));
  expect(fact(link, 'Expires')).toBe('Never');
  expect(fact(link, 'Last used')).toBe('Never');
  expect(fact(link, 'Password')).toBe('No');
  expect(fact(link, 'Comments')).toBe('Not allowed');
  // The maker is the owner, so the line names them once, as the owner does.
  expect(fact(link, 'Made by')).toBe('Bob Examplebob@example.test');
});

test('a link to one version names it', async () => {
  serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          share_link: fxAdminShareLink({ version: { id: 'ver_2', number: 2 } }),
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user);
  expect(fact(within(result.getByRole('group', { name: 'The share link' })), 'Shows')).toBe('v2');
});

test('a content URL shows the grant and its holder', async () => {
  serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          kind: 'content_grant',
          share_link: null,
          grant: { mode: 'review', expires_at: Date.now() + 5 * HOUR, holder: EVE },
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user, 'https://pinwall.test/c/tok/index.html', 'Content address');

  const grant = within(result.getByRole('group', { name: 'The open page' }));
  expect(fact(grant, 'Mode')).toBe('Review');
  expect(fact(grant, 'Holder')).toBe('Eve Exampleeve@example.test');
  expect(fact(grant, 'Expires')).toBe('in 5 hours');
  // The address was not a share URL, so there is no link to describe, and none to revoke.
  expect(result.queryByRole('group', { name: 'The share link' })).not.toBeInTheDocument();
  expect(result.queryByRole('button', { name: 'Revoke link' })).not.toBeInTheDocument();
});

test('a grant of a share link guest has no holder to name', async () => {
  serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          kind: 'content_grant',
          grant: { mode: 'raw', expires_at: Date.now() + 5 * HOUR, holder: null },
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user, 'https://pinwall.test/c/tok/', 'Content address');
  const grant = within(result.getByRole('group', { name: 'The open page' }));
  expect(fact(grant, 'Mode')).toBe('Raw');
  expect(fact(grant, 'Holder')).toBe('A visitor of a share link');
  // The link the grant came from is described too, and can be revoked.
  expect(result.getByRole('group', { name: 'The share link' })).toBeInTheDocument();
  expect(result.getByRole('button', { name: 'Revoke link' })).toBeInTheDocument();
});

test('an artifact link has neither link nor grant, and no owner to block when there is none', async () => {
  serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          kind: 'artifact',
          share_link: null,
          grant: null,
          artifact: { ...fxLookup().artifact, owner: null },
          version: { id: 'ver_2', number: 2, published_by: null },
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user, 'https://pinwall.test/a/art_1/v/2', 'Artifact link');
  const what = within(result.getByRole('group', { name: 'What it points to' }));
  expect(fact(what, 'Owner')).toBe('No account');
  expect(fact(what, 'Published by')).toBe('No account');
  expect(result.queryByRole('group', { name: 'The share link' })).not.toBeInTheDocument();
  expect(result.queryByRole('group', { name: 'The open page' })).not.toBeInTheDocument();
  expect(result.queryByRole('button', { name: 'Revoke link' })).not.toBeInTheDocument();
  expect(result.queryByRole('button', { name: 'Block owner' })).not.toBeInTheDocument();
  // Versions and the artifact can still be taken down.
  expect(result.getByRole('button', { name: 'End open pages of v2' })).toBeInTheDocument();
  expect(result.getByRole('button', { name: 'Delete v2' })).toBeInTheDocument();
  expect(result.getByRole('button', { name: 'Delete artifact' })).toBeInTheDocument();
});

test('an admin cannot block themselves from here', async () => {
  const me = fx.me();
  serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          artifact: {
            ...fxLookup().artifact,
            owner: fxAdminPerson({ id: me.id, name: me.name, email: me.email }),
          },
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user);
  expect(result.getByRole('button', { name: 'Delete artifact' })).toBeInTheDocument();
  expect(result.queryByRole('button', { name: 'Block owner' })).not.toBeInTheDocument();
});

test('each takedown asks first and calls its route', async () => {
  const { calls } = serveModeration({ grants: 3, links: [fxAdminShareLink()] });
  const users = serveAdminUsers({
    users: [
      fxOwnerRow(),
      fxAdminUser({ id: 'usr_b', name: 'Bob Example', email: 'bob@example.test' }),
    ],
  });
  const { user } = renderRoute('/admin/lookup');
  await lookUp(user);
  const sent = () => calls.length;
  const lookups = () => calls.filter((c) => c.path === '/admin/lookup').length;
  expect(lookups()).toBe(1);

  await takeDown(user, sent, 'Revoke link', 'Revoke link');
  await waitFor(() => expect(lookups()).toBe(2));
  await takeDown(user, sent, 'End open pages of v2', 'End open pages');
  expect(await screen.findByText('Ended 3 open pages.')).toBeInTheDocument();
  await waitFor(() => expect(lookups()).toBe(3));
  await takeDown(user, sent, 'Delete v2', 'Delete v2');
  await waitFor(() => expect(lookups()).toBe(4));
  await takeDown(user, sent, 'Delete artifact', 'Delete artifact');
  await waitFor(() => expect(lookups()).toBe(5));
  await takeDown(user, () => calls.length + users.calls.length, 'Block owner', 'Block');
  expect(await screen.findByText('Bob Example is blocked.')).toBeInTheDocument();
  await waitFor(() => expect(lookups()).toBe(6));

  // Each route once, in order, and a look-up of the same address after each.
  const lookup = { method: 'POST', path: '/admin/lookup', body: { url: SHARE_URL } };
  expect(calls).toEqual([
    lookup,
    { method: 'DELETE', path: '/admin/share-links/shr_1', body: undefined },
    lookup,
    { method: 'POST', path: '/admin/versions/ver_2/end-grants', body: undefined },
    lookup,
    { method: 'DELETE', path: '/admin/artifacts/art_1/versions/2', body: undefined },
    lookup,
    { method: 'DELETE', path: '/admin/artifacts/art_1', body: undefined },
    lookup,
    lookup,
  ]);
  expect(users.calls).toEqual([
    { method: 'PUT', path: '/admin/users/usr_b/role', body: { role_override: 'blocked' } },
  ]);
});

test('the takedown dialogs say what happens', async () => {
  serveModeration();
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user);

  const ask = async (button: string) => {
    await user.click(result.getByRole('button', { name: button }));
    const dialog = within(await screen.findByRole('alertdialog'));
    return {
      dialog,
      close: async () => {
        await user.click(dialog.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      },
    };
  };

  let asked = await ask('Revoke link');
  expect(asked.dialog.getByText('Revoke this link?')).toBeInTheDocument();
  expect(
    asked.dialog.getByText(
      'The link to “Pricing” stops working at once, and so do the pages it opened. The artifact and its other links stay.',
    ),
  ).toBeInTheDocument();
  await asked.close();

  asked = await ask('End open pages of v2');
  expect(asked.dialog.getByText('End the open pages of v2?')).toBeInTheDocument();
  expect(
    asked.dialog.getByText(/The version, its links and the artifact stay/),
  ).toBeInTheDocument();
  await asked.close();

  asked = await ask('Delete v2');
  expect(asked.dialog.getByText('Delete v2 of “Pricing”?')).toBeInTheDocument();
  expect(asked.dialog.getByText(/This cannot be undone/)).toBeInTheDocument();
  await asked.close();

  asked = await ask('Delete artifact');
  expect(asked.dialog.getByText('Delete “Pricing”?')).toBeInTheDocument();
  expect(
    asked.dialog.getByText(
      'Deletes “Pricing” for its owner too: every version, comment and share link. This cannot be undone.',
    ),
  ).toBeInTheDocument();
  await asked.close();

  asked = await ask('Block owner');
  expect(asked.dialog.getByText('Block Bob Example?')).toBeInTheDocument();
  expect(asked.dialog.getByText(/locked out at once/)).toBeInTheDocument();
  await asked.close();
});

test('ending one open page reads in the singular', async () => {
  const { calls } = serveModeration({ grants: 1 });
  const { user } = renderRoute('/admin/lookup');
  await lookUp(user);
  await takeDown(user, () => calls.length, 'End open pages of v2', 'End open pages');
  expect(await screen.findByText('Ended 1 open page.')).toBeInTheDocument();
});

test('a refused takedown stays in its dialog with the words of the server', async () => {
  serveModeration();
  const users = serveAdminUsers({
    users: [
      fxOwnerRow(),
      fxAdminUser({ id: 'usr_b', kind: 'owner', name: 'Bob Example', email: 'bob@example.test' }),
    ],
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user);

  await user.click(result.getByRole('button', { name: 'Block owner' }));
  const dialog = within(await screen.findByRole('alertdialog'));
  await user.click(dialog.getByRole('button', { name: 'Block' }));
  expect(
    await dialog.findByText(
      'The owner account is always an admin. Its role cannot be changed or blocked.',
    ),
  ).toBeInTheDocument();
  expect(users.calls).toHaveLength(1);
  // The result stays, since nothing changed.
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('region', { name: 'Share link' })).toBeInTheDocument();
});

test("refusals show the server's words", async () => {
  serveModeration({
    lookup: (url) => {
      if (url.endsWith('/bad')) return apiError(400, 'bad_request', t('moderation.lookup.badUrl'));
      if (url.endsWith('/unknown')) {
        return apiError(404, 'not_found', t('moderation.lookup.unknown'));
      }
      if (url.endsWith('/gone')) return apiError(410, 'gone', t('moderation.lookup.gone'));
      return HttpResponse.json(fxLookup());
    },
  });
  const { user } = renderRoute('/admin/lookup');
  const field = () => screen.getByRole('textbox', { name: 'Reported address' });

  await lookUp(user, 'https://pinwall.test/ok');
  await user.clear(field());
  await user.type(field(), 'pinwall.test/bad');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Paste the whole address, starting with http:// or https://.');
  // The message belongs to the field, and the answer it replaces is gone.
  expect(field()).toHaveAttribute('aria-invalid', 'true');
  expect(field()).toHaveAccessibleDescription(
    'Paste the whole address, starting with http:// or https://.',
  );
  expect(resultRegion()).not.toBeInTheDocument();

  await user.clear(field());
  await user.type(field(), 'https://pinwall.test/unknown');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This address does not belong to anything on this Pinwall.',
  );

  await user.clear(field());
  await user.type(field(), 'https://pinwall.test/gone');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'What this address pointed to has already been removed.',
  );

  // A good address clears the message.
  await user.clear(field());
  await user.type(field(), 'https://pinwall.test/ok');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
  expect(await screen.findByRole('region', { name: 'Share link' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an empty address is not sent', async () => {
  const { calls } = serveModeration();
  const { user } = renderRoute('/admin/lookup');
  await user.click(await screen.findByRole('button', { name: 'Look up' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Paste the whole address, starting with http:// or https://.',
  );
  expect(calls).toEqual([]);
});

test('Enter looks the address up, and spaces around it are not sent', async () => {
  const { calls } = serveModeration();
  const { user } = renderRoute('/admin/lookup');
  await user.type(
    await screen.findByRole('textbox', { name: 'Reported address' }),
    `  ${SHARE_URL}  {Enter}`,
  );
  expect(await screen.findByRole('region', { name: 'Share link' })).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'POST', path: '/admin/lookup', body: { url: SHARE_URL } }]);
});

test('after deleting, the look-up runs again and a 410 says it is already removed', async () => {
  let asked = 0;
  const { calls } = serveModeration({
    lookup: () => {
      asked += 1;
      return asked === 1
        ? HttpResponse.json(fxLookup())
        : apiError(410, 'gone', t('moderation.lookup.gone'));
    },
  });
  const { user } = renderRoute('/admin/lookup');
  await lookUp(user);

  await takeDown(user, () => calls.length, 'Delete artifact', 'Delete artifact');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'What this address pointed to has already been removed.',
  );
  expect(resultRegion()).not.toBeInTheDocument();
  expect(asked).toBe(2);
});

test('the reported address and names render as text', async () => {
  const address = 'https://pinwall.test/s/<b>x</b>';
  serveModeration({
    lookup: () =>
      HttpResponse.json(
        fxLookup({
          artifact: {
            id: 'art_1',
            name: '<b>x</b>',
            project: { id: 'prj_1', name: '<u>z</u>' },
            owner: fxAdminPerson({ name: '<i>y</i>', email: '<s>mail</s>@example.test' }),
          },
        }),
      ),
  });
  const { user } = renderRoute('/admin/lookup');
  const result = await lookUp(user, address);

  expect(result.getByText('<b>x</b>')).toBeInTheDocument();
  expect(result.getByText('<u>z</u>')).toBeInTheDocument();
  expect(result.getByText('<i>y</i>')).toBeInTheDocument();
  expect(result.getByText('<s>mail</s>@example.test')).toBeInTheDocument();
  expect(document.querySelector('main b, main u, main i, main s')).toBeNull();

  // The address stays in the field as typed; nothing on the page turns it into a link.
  expect(screen.getByRole('textbox', { name: 'Reported address' })).toHaveValue(address);
  expect(result.queryAllByRole('link')).toEqual([]);
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    expect(href).not.toContain('pinwall.test');
    expect(href).not.toContain('/s/');
    expect(href).not.toContain('/a/');
    expect(href).not.toContain('/c/');
  }
});

test('the admin nav reaches all four pages', async () => {
  serveAdminUsers({ users: [fxOwnerRow()] });
  serveModeration({ links: [fxAdminShareLink()] });
  serveAdminConfig(fxAdminConfig());
  const { user, router } = renderRoute('/admin');
  const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['Users', 'Share links', 'Look up a link', 'Configuration']);
  expect(router.state.location.pathname).toBe('/admin/users');
  expect(await screen.findByRole('table', { name: 'Users' })).toBeInTheDocument();

  await user.click(within(nav).getByRole('link', { name: 'Share links' }));
  expect(await screen.findByRole('table', { name: 'Share links' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/admin/share-links');

  await user.click(within(nav).getByRole('link', { name: 'Look up a link' }));
  expect(await screen.findByRole('textbox', { name: 'Reported address' })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/admin/lookup');
  expect(within(nav).getByRole('link', { name: 'Look up a link' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await user.click(within(nav).getByRole('link', { name: 'Configuration' }));
  expect(await screen.findByText(t('web.config.envNote'))).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/admin/config');
});
