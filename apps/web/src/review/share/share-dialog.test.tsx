import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { CreatedShareLink, Me, ShareLink } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { reviewer, serveReview } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';
import { canRevoke, EXPIRY_DAYS, expiresAtFor, shareStatus } from './share-status.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const TIMEOUT = { timeout: 5000 };
const DAY = 86_400_000;
/** A fixed "now", so an expiry can be compared exactly. */
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const grace = fx.me({ id: 'usr_2', name: 'Grace', role: 'member' });
const admin = fx.me({ id: 'usr_9', name: 'Root', role: 'admin' });
const byAda = { user_id: 'usr_1', name: 'Ada' };

/** The share-link calls of `art_1`, with the links `links` and the bodies and requests seen. */
function serveShares(o: { links?: ShareLink[] } = {}) {
  const state = {
    links: o.links ?? [],
    created: [] as unknown[],
    revoked: [] as string[],
    reads: 0,
    token: 'tok_secret_abc123',
  };
  server.use(
    http.get(`${API}/artifacts/art_1/share-links`, () => {
      state.reads += 1;
      return HttpResponse.json(fx.page(state.links));
    }),
    http.post(`${API}/artifacts/art_1/share-links`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      state.created.push(body);
      const link = fx.shareLink({
        id: `shl_new${state.created.length}`,
        version: body.version_id ? { id: String(body.version_id), number: 3 } : null,
        has_password: body.password != null,
        allow_comments: body.allow_comments === true,
        expires_at: (body.expires_at as number | null) ?? null,
        created_by: byAda,
        created_at: Date.now(),
      });
      state.links = [link, ...state.links];
      const created: CreatedShareLink = {
        link,
        token: state.token,
        url: `http://localhost:3000/s/${state.token}`,
      };
      return HttpResponse.json(created, { status: 201 });
    }),
    http.delete(`${API}/share-links/:id`, ({ params }) => {
      state.revoked.push(String(params.id));
      state.links = state.links.filter((l) => l.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

/** Opens the review of "Pricing" and its Share dialog. */
async function openShare(user: UserEvent): Promise<HTMLElement> {
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);
  await user.click(screen.getByRole('button', { name: 'Share' }));
  return screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);
}

async function choose(user: UserEvent, dialog: HTMLElement, field: string, option: string) {
  await user.click(within(dialog).getByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }, TIMEOUT));
}

test('expiry choices and the expiry they make', () => {
  expect([...EXPIRY_DAYS]).toEqual([null, 1, 7, 30]);
  expect(expiresAtFor(null, NOW)).toBeNull();
  expect(expiresAtFor(1, NOW)).toBe(NOW + DAY);
  expect(expiresAtFor(30, NOW)).toBe(NOW + 30 * DAY);
});

test('a link status reads from its expiry', () => {
  const link = (o: Partial<ShareLink>) => fx.shareLink(o);
  expect(shareStatus(link({}), NOW)).toEqual({ tone: 'neutral', key: 'web.share.status.never' });
  expect(shareStatus(link({ expires_at: NOW + 3 * DAY }), NOW)).toEqual({
    tone: 'neutral',
    key: 'web.share.status.expires',
    vars: { when: 'in 3 days' },
  });
  // The last day is a warning.
  expect(shareStatus(link({ expires_at: NOW + 5 * 3_600_000 }), NOW).tone).toBe('warning');
  expect(shareStatus(link({ expires_at: NOW - 1000, status: 'expired' }), NOW)).toEqual({
    tone: 'danger',
    key: 'web.share.status.expired',
  });
  // The server's word counts, and so does the clock when the list is older than the expiry.
  expect(shareStatus(link({ status: 'expired', expires_at: NOW + DAY }), NOW).key).toBe(
    'web.share.status.expired',
  );
  expect(shareStatus(link({ expires_at: NOW - 1 }), NOW).key).toBe('web.share.status.expired');
  expect(
    shareStatus(link({ status: 'revoked', revoked_at: NOW - 5, expires_at: NOW + DAY }), NOW),
  ).toEqual({ tone: 'danger', key: 'web.share.status.revoked' });
});

test('who may revoke a link', () => {
  const me = (o: Partial<Me>) => fx.me({ id: 'usr_2', role: 'member', ...o });
  const mine = fx.shareLink({ created_by: { user_id: 'usr_2', name: 'Grace' } });
  const theirs = fx.shareLink({ created_by: byAda });
  const orphan = fx.shareLink({ created_by: null });
  const made = (created_by: string | null) => ({ created_by });
  // The link's creator, the artifact's publisher, an admin.
  expect(canRevoke(me({}), made('usr_1'), mine)).toBe(true);
  expect(canRevoke(me({}), made('usr_2'), theirs)).toBe(true);
  expect(canRevoke(me({ role: 'admin' }), made('usr_1'), theirs)).toBe(true);
  expect(canRevoke(me({}), made('usr_1'), theirs)).toBe(false);
  expect(canRevoke(me({}), made(null), orphan)).toBe(false);
  expect(canRevoke(me({ role: 'admin' }), made(null), orphan)).toBe(true);
});

test('creates a public link to the latest version and shows it once', async () => {
  serveReview();
  const shares = serveShares({ links: [fx.shareLink({ id: 'shl_old', created_by: byAda })] });
  const { user, queryClient } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  await within(dialog).findByText('Latest version', {}, TIMEOUT);
  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));

  const url = `http://localhost:3000/s/${shares.token}`;
  const result = await screen.findByRole('dialog', { name: 'Link created' }, TIMEOUT);
  expect(shares.created).toEqual([
    { version_id: null, password: null, expires_at: null, allow_comments: false },
  ]);
  const field = within(result).getByRole('textbox', { name: 'Share link' });
  expect(field).toHaveValue(url);
  expect(within(result).getByText(t('web.share.urlOnce'))).toBeInTheDocument();

  // The token never reaches a cache.
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain(shares.token);
  expect(queryClient.getMutationCache().getAll()).toEqual([]);

  // Only Done leaves this step.
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: 'Link created' })).toBeInTheDocument();
  await user.click(within(result).getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByDisplayValue(url)).not.toBeInTheDocument(), TIMEOUT);
  expect(screen.queryByText(t('web.share.urlOnce'))).not.toBeInTheDocument();

  // Reopened, the dialog is a blank form over the list, which now holds the new link.
  await user.click(screen.getByRole('button', { name: 'Share' }));
  const again = await screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);
  expect(screen.queryByDisplayValue(url)).not.toBeInTheDocument();
  expect(within(again).getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  await waitFor(
    () => expect(within(again).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2),
    TIMEOUT,
  );
});

test('a per-version password link with expiry and comments', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  serveReview();
  const shares = serveShares();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  // The choices of the first two selects.
  await user.click(within(dialog).getByRole('combobox', { name: 'Link shows' }));
  expect(
    within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['The latest version (follows new versions)', 'v3 only']);
  await user.click(screen.getByRole('option', { name: 'v3 only' }));

  await user.click(within(dialog).getByRole('combobox', { name: 'Who can open it' }));
  expect(
    within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Anyone with the link', 'Anyone with the link and the password']);
  await user.click(screen.getByRole('option', { name: 'Anyone with the link and the password' }));

  const password = within(dialog).getByLabelText('Password');
  expect(password).toHaveAttribute('type', 'password');
  await user.type(password, 'Mật khẩu 1');
  await user.click(within(dialog).getByRole('button', { name: 'Show password' }));
  expect(password).toHaveAttribute('type', 'text');
  expect(password).toHaveValue('Mật khẩu 1');
  await user.click(within(dialog).getByRole('button', { name: 'Hide password' }));
  expect(password).toHaveAttribute('type', 'password');

  await user.click(within(dialog).getByRole('combobox', { name: 'Expires' }));
  expect(
    within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Never', 'In 1 day', 'In 7 days', 'In 30 days']);
  await user.click(screen.getByRole('option', { name: 'In 7 days' }));

  const comments = within(dialog).getByRole('switch', { name: 'Allow comments' });
  expect(comments).toHaveAttribute('aria-checked', 'false');
  expect(comments).toHaveAccessibleDescription(
    'People with the link can read comments and add their own under a name they choose.',
  );
  await user.click(comments);
  expect(comments).toHaveAttribute('aria-checked', 'true');

  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  await screen.findByRole('dialog', { name: 'Link created' }, TIMEOUT);
  expect(shares.created).toEqual([
    {
      version_id: 'ver_3',
      password: 'Mật khẩu 1',
      expires_at: NOW + 604_800_000,
      allow_comments: true,
    },
  ]);
});

test('a short password is refused before sending', async () => {
  serveReview();
  const shares = serveShares();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  await choose(user, dialog, 'Who can open it', 'Anyone with the link and the password');
  const password = within(dialog).getByLabelText('Password');
  await user.type(password, 'seven77');
  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));

  expect(await within(dialog).findByText(t('share.passwordTooShort', { min: 8 }))).toBeVisible();
  expect(password).toHaveFocus();
  expect(shares.created).toEqual([]);

  // Characters are counted as code points, not UTF-16 units: seven emoji are fourteen units.
  await user.clear(password);
  await user.click(password);
  await user.paste('🙂🙂🙂🙂🙂🙂🙂');
  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  expect(await within(dialog).findByText(t('share.passwordTooShort', { min: 8 }))).toBeVisible();
  expect(shares.created).toEqual([]);

  // The error clears as the password is edited; eight code points go through.
  await user.type(password, 'x');
  expect(within(dialog).queryByText(t('share.passwordTooShort', { min: 8 }))).toBeNull();
  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  await screen.findByRole('dialog', { name: 'Link created' }, TIMEOUT);
  expect(shares.created).toHaveLength(1);
});

test('going back to anyone clears the password', async () => {
  serveReview();
  const shares = serveShares();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  await choose(user, dialog, 'Who can open it', 'Anyone with the link and the password');
  await user.type(within(dialog).getByLabelText('Password'), 'long enough pw');
  await choose(user, dialog, 'Who can open it', 'Anyone with the link');
  expect(within(dialog).queryByLabelText('Password')).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  await screen.findByRole('dialog', { name: 'Link created' }, TIMEOUT);
  expect(shares.created).toEqual([
    { version_id: null, password: null, expires_at: null, allow_comments: false },
  ]);
});

test('a refused link keeps the form and says why', async () => {
  serveReview();
  serveShares();
  server.use(
    http.post(`${API}/artifacts/art_1/share-links`, () =>
      apiError(400, 'invalid_request', 'Choose an expiry in the future.'),
    ),
  );
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  expect(await within(dialog).findByText('Choose an expiry in the future.')).toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Link created' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeEnabled();
});

test('existing links show scope, access, status and creator', async () => {
  serveReview();
  serveShares({
    links: [
      fx.shareLink({
        id: 'shl_1',
        version: { id: 'ver_2', number: 2 },
        has_password: true,
        allow_comments: true,
        expires_at: Date.now() - DAY,
        status: 'expired',
        created_by: byAda,
        created_at: Date.now() - 3 * DAY,
        last_used_at: Date.now() - 2 * 3_600_000,
      }),
      fx.shareLink({
        id: 'shl_2',
        created_by: { user_id: 'usr_5', name: 'Grace' },
        created_at: Date.now() - 3_600_000,
        expires_at: Date.now() + 3 * DAY + 3_600_000,
      }),
      fx.shareLink({ id: 'shl_3', created_by: null, created_at: Date.now() - 60 * DAY }),
    ],
  });
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  const rows = await within(dialog).findAllByRole('listitem', {}, TIMEOUT);
  expect(rows).toHaveLength(3);

  const [first, second, third] = rows.map((row) => within(row));
  expect(first?.getByText('v2')).toBeInTheDocument();
  expect(first?.getByText('Password')).toBeInTheDocument();
  expect(first?.getByText('Comments')).toBeInTheDocument();
  expect(first?.getByText(/by Ada/)).toBeInTheDocument();
  expect(first?.getByText(/3 days ago/)).toBeInTheDocument();
  expect(first?.getByText(/Last used 2 hours ago/)).toBeInTheDocument();
  const expired = first?.getByText('Expired');
  expect(expired).toBeInTheDocument();
  expect(expired?.closest('span[class*="bg-danger-soft"]')).not.toBeNull();

  expect(second?.getByText('Latest version')).toBeInTheDocument();
  expect(second?.queryByText('Password')).not.toBeInTheDocument();
  expect(second?.queryByText('Comments')).not.toBeInTheDocument();
  expect(second?.getByText('Expires in 3 days')).toBeInTheDocument();
  expect(second?.getByText(/by Grace/)).toBeInTheDocument();
  expect(second?.getByText('Not used yet')).toBeInTheDocument();

  expect(third?.getByText('No expiry')).toBeInTheDocument();
  expect(third?.getByText(/a former member/)).toBeInTheDocument();
});

test('revoke asks first and is offered only to those allowed', async () => {
  serveReview();
  const shares = serveShares({
    links: [
      fx.shareLink({ id: 'shl_1', created_by: { user_id: 'usr_2', name: 'Grace' } }),
      fx.shareLink({ id: 'shl_2', created_by: byAda, version: { id: 'ver_2', number: 2 } }),
    ],
  });
  // Grace is a member who did not publish "Pricing" (Ada did).
  const { user } = renderRoute('/a/art_1', { me: grace });
  const dialog = await openShare(user);

  const rows = await within(dialog).findAllByRole('listitem', {}, TIMEOUT);
  expect(rows).toHaveLength(2);
  // Her own link can be revoked, Ada's cannot.
  expect(within(rows[1] as HTMLElement).queryByRole('button', { name: /^Revoke/ })).toBeNull();
  const revoke = within(rows[0] as HTMLElement).getByRole('button', { name: /^Revoke/ });

  await user.click(revoke);
  const confirm = await screen.findByRole('alertdialog', { name: 'Revoke this link?' }, TIMEOUT);
  // Cancel leaves it be.
  await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(), TIMEOUT);
  expect(shares.revoked).toEqual([]);

  const readsBefore = shares.reads;
  await user.click(revoke);
  await user.click(
    within(await screen.findByRole('alertdialog', {}, TIMEOUT)).getByRole('button', {
      name: 'Revoke link',
    }),
  );
  await waitFor(() => expect(shares.revoked).toEqual(['shl_1']), TIMEOUT);
  // The list is read again and the row is gone.
  await waitFor(() => expect(shares.reads).toBeGreaterThan(readsBefore), TIMEOUT);
  await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(1), TIMEOUT);
});

test('an admin may revoke any link, and a refusal shows as the server wrote it', async () => {
  serveReview();
  serveShares({ links: [fx.shareLink({ id: 'shl_1', created_by: byAda })] });
  const forbidden = t('share.revokeForbidden');
  server.use(http.delete(`${API}/share-links/shl_1`, () => apiError(403, 'forbidden', forbidden)));
  const { user } = renderRoute('/a/art_1', { me: admin });
  const dialog = await openShare(user);

  await user.click(await within(dialog).findByRole('button', { name: /^Revoke/ }, TIMEOUT));
  const confirm = await screen.findByRole('alertdialog', {}, TIMEOUT);
  await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));
  expect(await within(confirm).findByText(forbidden)).toBeVisible();
  // The question stays open, and the row is still there once it is closed.
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(), TIMEOUT);
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
});

test('list states', async () => {
  serveReview();
  const reads: Array<() => Response | Promise<Response>> = [];
  server.use(
    http.get(`${API}/artifacts/art_1/share-links`, async () => {
      const next = reads.shift();
      return next ? next() : HttpResponse.json(fx.page([]));
    }),
  );

  // Loading, then a server error.
  reads.push(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return apiError(500, 'internal', 'The links could not be read.');
    },
    () => HttpResponse.json(fx.page([])),
  );
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);
  expect(within(dialog).getByRole('status', { name: 'Loading share links' })).toBeInTheDocument();

  expect(
    await within(dialog).findByText('The links could not be read.', {}, TIMEOUT),
  ).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Retry' }));

  // Then nothing yet.
  expect(await within(dialog).findByText(t('web.share.none'), {}, TIMEOUT)).toBeVisible();
  expect(within(dialog).queryByRole('listitem')).not.toBeInTheDocument();
});

test('more than a page of links loads on request', async () => {
  serveReview();
  const first = Array.from({ length: 2 }, (_, i) => fx.shareLink({ id: `shl_${i}` }));
  const second = [fx.shareLink({ id: 'shl_9', version: { id: 'ver_1', number: 1 } })];
  server.use(
    http.get(`${API}/artifacts/art_1/share-links`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      return cursor === 'next'
        ? HttpResponse.json(fx.page(second))
        : HttpResponse.json(fx.page(first, 'next'));
    }),
  );
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);

  expect(await within(dialog).findAllByRole('listitem', {}, TIMEOUT)).toHaveLength(2);
  await user.click(within(dialog).getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(3), TIMEOUT);
  expect(within(dialog).queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('on a phone Share is in the menu and opens the dialog', async () => {
  setViewport(360);
  serveReview();
  serveShares();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByTitle('Pricing, v3', {}, TIMEOUT);

  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Share' }, TIMEOUT));
  const dialog = await screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);
  expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeInTheDocument();
});

test('the dialog names the artifact as text', async () => {
  const s = serveReview();
  s.artifact = { ...s.artifact, name: '<img src=x onerror=alert(1)>' };
  serveShares();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' }, TIMEOUT);
  await user.click(screen.getByRole('button', { name: 'Share' }));
  const dialog = await screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);
  expect(dialog).toHaveAccessibleName('Share “<img src=x onerror=alert(1)>”');
  expect(dialog.querySelector('img')).toBeNull();
});

test('a version the list has not read offers only the latest', async () => {
  serveReview();
  serveShares();
  const { user } = renderRoute('/a/art_1/v/9', { me: reviewer });
  await screen.findByRole('heading', { name: 'Pricing' }, TIMEOUT);
  await user.click(screen.getByRole('button', { name: 'Share' }));
  const dialog = await screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);

  await user.click(within(dialog).getByRole('combobox', { name: 'Link shows' }));
  expect(
    within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['The latest version (follows new versions)']);
});

test('a pinned link keeps the version it was chosen on when the review moves on', async () => {
  const s = serveReview({ versions: [3] });
  const shares = serveShares();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const dialog = await openShare(user);
  act(() => FakeEventSource.instances.at(-1)?.open());

  await choose(user, dialog, 'Link shows', 'v3 only');
  // A version is published while the dialog is open, and the review follows it.
  s.publish(4);
  act(() =>
    FakeEventSource.instances.at(-1)?.emit(
      'version.published',
      JSON.stringify({
        type: 'version.published',
        artifact_id: 'art_1',
        version_id: 'ver_4',
        number: 4,
      }),
    ),
  );
  await waitFor(() => expect(s.previews).toContain(4), TIMEOUT);

  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  await screen.findByRole('dialog', { name: 'Link created' }, TIMEOUT);
  expect(shares.created).toEqual([
    { version_id: 'ver_3', password: null, expires_at: null, allow_comments: false },
  ]);
});

test('with no version there is nothing to share yet', async () => {
  serveReview({ versions: [] });
  renderRoute('/a/art_1', { me: reviewer });
  await screen.findByText(t('web.review.noVersion'), {}, TIMEOUT);
  expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
});
