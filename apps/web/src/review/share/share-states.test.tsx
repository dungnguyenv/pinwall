import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { Me, ShareLink } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { reviewer, serveReview } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';
import { fxOwn, fxShared, PERSONAL } from '../../test/spaces.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const TIMEOUT = { timeout: 5000 };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const byAda = { user_id: reviewer.id, name: reviewer.name };
/** Ada's own link, which she can revoke whatever else she may do. */
const own = fx.shareLink({ id: 'shr_1', created_by: byAda });

/** `reviewer`, whose `can_create_share_links` is `allowed` (absent: the field is left out). */
function person(allowed?: boolean): Me {
  return allowed === undefined ? reviewer : fx.me({ ...reviewer, can_create_share_links: allowed });
}

/** The share-link calls of `art_1`, with the links `links`, and what was created and revoked. */
function serveShares(links: ShareLink[] = [own]) {
  const state = { links, created: [] as unknown[], revoked: [] as string[] };
  server.use(
    http.get(`${API}/artifacts/art_1/share-links`, () => HttpResponse.json(fx.page(state.links))),
    http.post(`${API}/artifacts/art_1/share-links`, async ({ request }) => {
      state.created.push(await request.json());
      return HttpResponse.json(
        { link: fx.shareLink({ id: 'shr_new' }), token: 'tok_x', url: 'http://localhost/s/tok_x' },
        { status: 201 },
      );
    }),
    http.delete(`${API}/share-links/:id`, ({ params }) => {
      state.revoked.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

/** Opens the review of "Pricing" and its Share dialog. */
async function openShare(user: UserEvent): Promise<HTMLElement> {
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);
  // The project is read, so the person's role in it is known.
  const breadcrumb = await screen.findByRole('navigation', { name: 'Breadcrumb' }, TIMEOUT);
  await within(breadcrumb).findByRole('link', { name: 'Launch site' }, TIMEOUT);
  await user.click(screen.getByRole('button', { name: 'Share' }));
  return screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);
}

/** Serves the review of "Pricing" in a project in which the person is a viewer. */
function serveAsViewer() {
  serveReview({ versions: [1] });
  server.use(
    http.get(`${API}/projects/prj_2`, () =>
      HttpResponse.json(fxShared('viewer', { id: 'prj_2', name: 'Launch site' })),
    ),
  );
}

test('a person who is not approved sees why instead of the form, and still lists and revokes their links', async () => {
  serveReview({ versions: [1] });
  const shares = serveShares();
  const { user } = renderRoute('/a/art_1/v/1', { me: person(false) });
  const dialog = await openShare(user);

  expect(
    await within(dialog).findByText(t('web.share.notApproved.title'), {}, TIMEOUT),
  ).toBeVisible();
  // The explanation is one named piece, so it is read as a whole.
  const why = within(dialog).getByRole('status', { name: t('web.share.notApproved.title') });
  expect(within(why).getByText(t('spaces.exposure.shareLink'))).toBeVisible();
  // Links made while the policy let them are suspended, which the link list does not say.
  expect(within(dialog).getByText(t('web.share.notApproved.suspended'))).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  // The footer's one button closes.
  expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);

  // The list stays, and the link is theirs to revoke.
  const row = await within(dialog).findByRole('listitem', {}, TIMEOUT);
  await user.click(within(row).getByRole('button', { name: /^Revoke/ }));
  const confirm = await screen.findByRole('alertdialog', { name: 'Revoke this link?' }, TIMEOUT);
  await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));
  await waitFor(() => expect(shares.revoked).toEqual(['shr_1']), TIMEOUT);
});

test('a viewer sees why they cannot share, and revokes nothing', async () => {
  serveAsViewer();
  serveShares();
  const { user } = renderRoute('/a/art_1/v/1', { me: person(), config: PERSONAL });
  const dialog = await openShare(user);

  expect(
    await within(dialog).findByText(t('web.share.viewerRole.title'), {}, TIMEOUT),
  ).toBeVisible();
  const why = within(dialog).getByRole('status', { name: t('web.share.viewerRole.title') });
  expect(within(why).getByText(t('spaces.role.createShareLink'))).toBeVisible();
  // Nothing about approval: the person is a viewer, not unapproved.
  expect(within(dialog).queryByText(t('web.share.notApproved.title'))).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  // The list stays, without Revoke.
  await within(dialog).findByRole('listitem', {}, TIMEOUT);
  expect(within(dialog).queryByRole('button', { name: /^Revoke/ })).not.toBeInTheDocument();
});

test('a person who is neither approved nor an editor hears about approval first', async () => {
  // The server asks about approval first, so the page does too.
  serveAsViewer();
  serveShares();
  const { user } = renderRoute('/a/art_1/v/1', { me: person(false), config: PERSONAL });
  const dialog = await openShare(user);

  expect(
    await within(dialog).findByText(t('web.share.notApproved.title'), {}, TIMEOUT),
  ).toBeVisible();
  expect(within(dialog).queryByText(t('web.share.viewerRole.title'))).not.toBeInTheDocument();
});

/** Opens the Share dialog as soon as the version shows, before the project may have answered. */
async function openShareAtOnce(user: UserEvent): Promise<HTMLElement> {
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);
  await user.click(screen.getByRole('button', { name: 'Share' }));
  return screen.findByRole('dialog', { name: /^Share/ }, TIMEOUT);
}

test('while the role is read, the dialog says so: no reason and no form yet', async () => {
  serveReview({ versions: [1] });
  serveShares();
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  server.use(
    http.get(`${API}/projects/prj_2`, async () => {
      await answered;
      return HttpResponse.json(fxOwn({ id: 'prj_2', name: 'Launch site' }));
    }),
  );
  const { user } = renderRoute('/a/art_1/v/1', { me: person(), config: PERSONAL });
  const dialog = await openShareAtOnce(user);

  expect(within(dialog).getByRole('status', { name: t('web.share.roleLoading') })).toBeVisible();
  // An owner is never told they are a viewer, and nothing offers a link yet.
  expect(within(dialog).queryByText(t('web.share.viewerRole.title'))).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  expect(within(dialog).queryByText(t('web.share.hint'))).not.toBeInTheDocument();

  answer();
  expect(await within(dialog).findByRole('button', { name: 'Create link' }, TIMEOUT)).toBeVisible();
  expect(within(dialog).getByText(t('web.share.hint'))).toBeInTheDocument();
  expect(
    within(dialog).queryByRole('status', { name: t('web.share.roleLoading') }),
  ).not.toBeInTheDocument();
  expect(within(dialog).queryByText(t('web.share.viewerRole.title'))).not.toBeInTheDocument();
});

test('a project that cannot be read shows an error with Retry, never the viewer reason', async () => {
  serveReview({ versions: [1] });
  serveShares();
  // Every read fails until the server is back.
  let back = false;
  server.use(
    http.get(`${API}/projects/prj_2`, () =>
      back
        ? HttpResponse.json(fxShared('editor', { id: 'prj_2', name: 'Launch site' }))
        : apiError(503, 'unavailable', 'Pinwall is busy. Try again.'),
    ),
  );
  const { user } = renderRoute('/a/art_1/v/1', { me: person(), config: PERSONAL });
  const dialog = await openShareAtOnce(user);

  const failed = await within(dialog).findByRole('alert', {}, TIMEOUT);
  expect(failed).toHaveTextContent(t('web.share.roleFailed'));
  expect(failed).toHaveTextContent('Pinwall is busy. Try again.');
  expect(within(dialog).queryByText(t('web.share.viewerRole.title'))).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();

  // Read again, the project says the person is an editor, who may make links.
  back = true;
  await user.click(within(failed).getByRole('button', { name: 'Retry' }));
  expect(await within(dialog).findByRole('button', { name: 'Create link' }, TIMEOUT)).toBeVisible();
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  expect(within(dialog).queryByText(t('web.share.viewerRole.title'))).not.toBeInTheDocument();
});

test('approval taken away while the dialog is open switches it to the explanation', async () => {
  serveReview({ versions: [1] });
  const shares = serveShares();
  // Allowed when the page loads; the server then stops allowing it.
  let approved = true;
  let meReads = 0;
  server.use(
    http.get(`${API}/me`, () => {
      meReads += 1;
      return HttpResponse.json(person(approved));
    }),
    http.post(`${API}/artifacts/art_1/share-links`, () =>
      apiError(403, 'forbidden', t('spaces.exposure.shareLink'), {
        reason: 'share_links_not_approved',
      }),
    ),
  );
  const { user } = renderRoute('/a/art_1/v/1');
  const dialog = await openShare(user);
  expect(shares.created).toEqual([]);

  approved = false;
  const readsBefore = meReads;
  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));

  expect(
    await within(dialog).findByText(t('web.share.notApproved.title'), {}, TIMEOUT),
  ).toBeVisible();
  expect(within(dialog).getByText(t('spaces.exposure.shareLink'))).toBeVisible();
  // The words that replace the form take its focus, and say what they are about.
  expect(
    within(dialog).getByRole('status', { name: t('web.share.notApproved.title') }),
  ).toHaveFocus();
  // The person is read again, so the rest of the app learns of it too.
  await waitFor(() => expect(meReads).toBeGreaterThan(readsBefore), TIMEOUT);
  // The form and its alert are gone, and no toast speaks.
  expect(within(dialog).queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  expect(document.querySelector('[data-sonner-toast]')).toBeNull();
  // Once the person is read again, the explanation stands on their own word.
  expect(within(dialog).getByText(t('web.share.notApproved.title'))).toBeVisible();
});

test('another refusal keeps the form and its alert', async () => {
  serveReview({ versions: [1] });
  serveShares();
  const message = 'Too many share links were made. Try again later.';
  server.use(
    http.post(`${API}/artifacts/art_1/share-links`, () => apiError(429, 'rate_limited', message)),
  );
  const { user } = renderRoute('/a/art_1/v/1', { me: person(true) });
  const dialog = await openShare(user);

  await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
  expect(await within(dialog).findByRole('alert', {}, TIMEOUT)).toHaveTextContent(message);
  expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  expect(within(dialog).queryByText(t('web.share.notApproved.title'))).not.toBeInTheDocument();
});

test('without the field, and when approved, the 1.0 form shows', async () => {
  for (const allowed of [undefined, true]) {
    serveReview({ versions: [1] });
    serveShares();
    const { user } = renderRoute('/a/art_1/v/1', { me: person(allowed) });
    const dialog = await openShare(user);

    expect(within(dialog).getByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(dialog).queryByText(t('web.share.notApproved.title'))).not.toBeInTheDocument();
    expect(within(dialog).queryByText(t('web.share.viewerRole.title'))).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), TIMEOUT);
    cleanup();
  }
});

/** The review menu's item labels, with the menu left open. */
async function openMenu(user: UserEvent): Promise<HTMLElement> {
  await screen.findByTitle('Pricing, v1', {}, TIMEOUT);
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  return screen.findByRole('menu', {}, TIMEOUT);
}

test('Open raw page explains why it is unavailable to a person who is not approved', async () => {
  serveReview({ versions: [1] });
  const { user } = renderRoute('/a/art_1/v/1', { me: person(false) });
  const menu = await openMenu(user);

  expect(within(menu).queryByRole('menuitem', { name: 'Open raw page' })).not.toBeInTheDocument();
  expect(within(menu).queryByRole('menuitem', { name: 'Copy raw link' })).not.toBeInTheDocument();
  await user.click(within(menu).getByRole('menuitem', { name: t('web.review.rawUnavailable') }));

  const dialog = await screen.findByRole(
    'dialog',
    { name: t('web.review.rawUnavailable') },
    TIMEOUT,
  );
  expect(within(dialog).getByText(t('spaces.exposure.rawLink'))).toBeVisible();
  // Nothing on the page leads to a raw link.
  expect(document.querySelector('a[href$="/raw"]')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open raw page' })).not.toBeInTheDocument();

  await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), TIMEOUT);
});

test('Open raw page is a link for a person who is approved, or whose Pinwall sends no field', async () => {
  for (const allowed of [true, undefined]) {
    serveReview({ versions: [1] });
    const { user } = renderRoute('/a/art_1/v/1', { me: person(allowed) });
    const menu = await openMenu(user);

    const raw = within(menu).getByRole('menuitem', { name: 'Open raw page' });
    expect(raw).toHaveAttribute('href', '/a/art_1/v/1/raw');
    expect(within(menu).getByRole('menuitem', { name: 'Copy raw link' })).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: t('web.review.rawUnavailable') }),
    ).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    cleanup();
  }
});
