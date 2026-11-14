import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { apiCall, publishInline } from '../support/in-page-api.ts';
import { axe, personIn, SPACES_ORIGIN, t } from './support.ts';

/*
 * Spec acceptance 2, 3 and 9 through the web, in personal mode with open sign-up and
 * `PINWALL_SHARE_LINKS=approved`: the second Pinwall of this suite (see `global-setup.ts`).
 * The walks share one Pinwall, so each builds on the one before.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

/** What walk 2 makes and walk 3 visits: Eve's page. */
let eveNotes: string | undefined;

/** Every browser context a walk opens, so each is closed even when the walk fails. */
const opened: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

/** A person in a browser of their own, signed in. */
async function person(browser: Browser, user: 'ada' | 'bob' | 'eve'): Promise<Page> {
  const { context, page } = await personIn(browser, SPACES_ORIGIN, user);
  opened.push(context);
  return page;
}

/** Someone with no account, in a browser of their own. */
async function visitor(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  return context.newPage();
}

/** A page of the artifact's own, with a title (which names the artifact) and a body. */
function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

/** Where `path` is on the Pinwall of this suite. */
function at(path: string): string {
  return new URL(path, SPACES_ORIGIN).href;
}

/** The sidebar: its projects, the ones shared with the person, and what they opened lately. */
function sidebar(page: Page) {
  return page.getByRole('navigation', { name: t('web.sidebar.navLabel') });
}

/** Opens search from the sidebar and types `term`; returns the search dialog. */
async function searchFor(page: Page, term: string) {
  await sidebar(page)
    .getByRole('button', { name: t('web.sidebar.search'), exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: t('web.search.title') });
  await dialog.getByRole('combobox', { name: t('web.search.label') }).fill(term);
  return dialog;
}

/**
 * Opens `/a/<id>` and says what a person sees where the artifact would be, when there is
 * nothing: the page's whole main area, so two addresses can be compared word for word.
 */
async function unavailableText(page: Page, id: string): Promise<string | null> {
  await page.goto(at(`/a/${id}`));
  await expect(page.getByRole('heading', { name: t('web.artifact.unavailable') })).toBeVisible();
  await expect(page.getByText(t('artifact.notFound'))).toBeVisible();
  return page.locator('main').textContent();
}

/** The frame address of the review screen of `/a/<id>`, waiting until the page is on screen. */
async function reviewSrc(page: Page, id: string): Promise<string> {
  await page.goto(at(`/a/${id}`));
  const frame = page.locator('iframe[sandbox]');
  await expect(frame).toHaveAttribute('src', /\/c\//);
  return new URL((await frame.getAttribute('src')) ?? '', SPACES_ORIGIN).href;
}

/** Makes a project from the sidebar and returns its id. */
async function createProject(page: Page, name: string): Promise<string> {
  await sidebar(page)
    .getByRole('button', { name: t('web.sidebar.newProject') })
    .click();
  const dialog = page.getByRole('dialog', { name: t('web.newProject.title') });
  await dialog.getByLabel(t('web.newProject.name')).fill(name);
  await dialog.getByRole('button', { name: t('web.newProject.create') }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const id = /\/projects\/([^/?#]+)/.exec(page.url())?.[1];
  if (id === undefined)
    throw new Error(`The page of project ${name} has no project id: ${page.url()}`);
  return id;
}

/** The switch that lets `name` expose content, on Admin → Users. */
async function approvalSwitch(admin: Page, name: string) {
  await admin.goto(at('/admin/users'));
  const approval = admin.getByRole('switch', { name: t('web.admin.approval.for', { name }) });
  await expect(approval).toBeVisible();
  return approval;
}

/** True once the server has answered a change to a person's record. */
function personSaved(admin: Page): Promise<unknown> {
  return admin.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      /\/api\/v1\/admin\/users\/[^/]+$/.test(response.url()),
  );
}

/** Lets `name` expose content, as an admin does on Admin → Users. */
async function approve(admin: Page, name: string): Promise<void> {
  const approval = await approvalSwitch(admin, name);
  const saved = personSaved(admin);
  await approval.click();
  await saved;
  await expect(approval).toBeChecked();
}

/**
 * Opens the Share dialog of the artifact on screen, makes a link and returns its address. A link
 * that allows comments opens the share viewer; one that does not redirects to the raw page.
 */
async function createShareLink(page: Page, options: { comments?: boolean } = {}): Promise<string> {
  await page.getByRole('button', { name: t('web.review.share'), exact: true }).click();
  if (options.comments) await page.getByRole('switch', { name: t('web.share.comments') }).check();
  await page.getByRole('button', { name: t('web.share.create') }).click();
  const created = page.getByRole('dialog', { name: t('web.share.createdTitle') });
  const url = await created.getByLabel(t('web.share.link'), { exact: true }).inputValue();
  await created.getByRole('button', { name: t('web.share.done') }).click();
  await expect(created).toBeHidden();
  return url;
}

/**
 * No WCAG 2.1 A or AA violation on the page now, in the light scheme and in the dark one. A
 * change of scheme fades its colors, a dialog fades in, and contrast is read from what is on
 * screen, so what moves ends first (what moves for good, a loading shimmer, never ends); and the
 * two schemes must differ, or the dark run would only repeat the light one.
 */
async function expectAccessible(page: Page): Promise<void> {
  const canvases: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() =>
      Promise.allSettled(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
          .map((animation) => animation.finished),
      ),
    );
    canvases.push(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    expect((await axe(page)).violations, `${scheme} scheme`).toEqual([]);
  }
  expect(canvases[1], 'the dark canvas differs from the light one').not.toBe(canvases[0]);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Opens the members of the project on screen. */
async function openMembers(page: Page, project: string) {
  await page.getByRole('button', { name: t('web.members.button') }).click();
  return page.getByRole('dialog', { name: t('web.members.title', { project }) });
}

/** Pins a comment with `text` on the words of `selector`, in comment mode, on the page shown. */
async function comment(page: Page, selector: string, text: string): Promise<void> {
  await expect(page.locator('[data-annotator="ready"]')).toBeVisible();
  await page.getByRole('button', { name: t('web.review.commentMode') }).click();
  const words = await page.frameLocator('iframe[sandbox]').locator(selector).boundingBox();
  if (words === null) throw new Error(`${selector} is not on screen`);
  const y = words.y + words.height / 2;
  await page.mouse.move(words.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(words.x + words.width - 1, y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: t('web.comments.composerLabel') }).fill(text);
  await page.getByRole('button', { name: t('web.comments.post'), exact: true }).click();
}

test("acceptance 2: a first sign-in gets an empty space and cannot reach another person's artifact", async ({
  browser,
}) => {
  // Bob publishes a page into his space and can find it.
  const bob = await person(browser, 'bob');
  const plan = await publishInline(bob, {
    'index.html': html('Bob plan', '<h1>Bob plan</h1><p>The plan for the launch.</p>'),
  });
  const bobSearch = await searchFor(bob, 'plan');
  await expect(bobSearch.getByRole('option', { name: /Bob plan/ })).toBeVisible();

  // Eve signs in for the first time with no group: Pinwall lets her in, to a space of her own.
  const eve = await person(browser, 'eve');
  const me = await apiCall<{ role: string; email: string }>(eve, 'GET', '/api/v1/me');
  expect(me.json).toMatchObject({ role: 'member', email: 'eve@example.test' });
  await expect(eve.getByText(t('web.library.spaceEmptyTitle'))).toBeVisible();
  const bar = sidebar(eve);
  await expect(bar.getByRole('heading', { name: t('web.sidebar.projects') })).toBeVisible();
  await expect(bar.getByRole('heading', { name: t('web.sidebar.recent') })).toBeVisible();
  await expect(bar.getByText('Bob plan')).toHaveCount(0);

  // Search does not find it for her.
  const eveSearch = await searchFor(eve, 'plan');
  await expect(eveSearch.getByText(t('web.search.noResults', { q: 'plan' }))).toBeVisible();
  await expect(eveSearch.getByRole('option')).toHaveCount(0);
  await eve.keyboard.press('Escape');

  // Its address says nothing she could not have heard about any artifact that is not there.
  const forBobsPlan = await unavailableText(eve, plan.artifact_id);
  const forNothing = await unavailableText(eve, 'art_00000000000000000000');
  expect(forBobsPlan).toBe(forNothing);

  // She publishes, and her library holds that and nothing else.
  const notes = await publishInline(eve, {
    'index.html': html('Eve notes', '<h1>Eve notes</h1><p>Her own page.</p>'),
  });
  eveNotes = notes.artifact_id;
  await eve.goto(at('/'));
  const library = eve.getByRole('list', { name: t('web.library.allTitle') });
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await expect(library.getByRole('link', { name: /^Eve notes/ })).toBeVisible();

  // The sign-in page, with no one signed in, says what this Pinwall asks of people (D8).
  const out = await visitor(browser);
  await out.goto(at('/signin'));
  await expect(out.getByRole('heading', { name: t('web.signin.title') })).toBeVisible();
  await expect(out.getByRole('link', { name: t('web.policy.terms') })).toHaveAttribute(
    'href',
    'https://example.test/terms',
  );
  await expect(out.getByRole('link', { name: t('web.policy.privacy') })).toHaveAttribute(
    'href',
    'https://example.test/privacy',
  );
  await expect(out.getByRole('link', { name: 'abuse@example.test' })).toHaveAttribute(
    'href',
    'mailto:abuse@example.test',
  );
  await expectAccessible(out);
  await expectAccessible(eve);
});

test('acceptance 3: approval gates share links, raw links and top-level content', async ({
  browser,
}) => {
  if (eveNotes === undefined) throw new Error('The walk above makes the page Eve notes');
  const notesId = eveNotes;
  const eve = await person(browser, 'eve');
  const src = await reviewSrc(eve, notesId);

  // Not approved yet, her page still shows in Pinwall's viewer.
  await expect(
    eve.frameLocator('iframe[sandbox]').getByRole('heading', { name: 'Eve notes' }),
  ).toBeVisible();

  // Share explains, and offers no link.
  await eve.getByRole('button', { name: t('web.review.share'), exact: true }).click();
  const share = eve.getByRole('dialog', { name: t('web.share.title', { name: 'Eve notes' }) });
  await expect(share.getByRole('status', { name: t('web.share.notApproved.title') })).toBeVisible();
  await expect(share.getByRole('button', { name: t('web.share.create') })).toHaveCount(0);
  await expectAccessible(eve);
  await eve.keyboard.press('Escape');
  await expect(share).toBeHidden();

  // Nor does the server make one for her, asked directly.
  const noLink = await apiCall<{ error: { details?: { reason?: string } } }>(
    eve,
    'POST',
    `/api/v1/artifacts/${notesId}/share-links`,
    {},
  );
  expect(noLink.status).toBe(403);
  expect(noLink.json.error.details?.reason).toBe('share_links_not_approved');

  // The raw page is not hers to open, and the menu says why.
  await eve.getByRole('button', { name: t('web.review.more') }).click();
  await eve.getByRole('menuitem', { name: t('web.review.rawUnavailable') }).click();
  const why = eve.getByRole('dialog', { name: t('web.review.rawUnavailable') });
  await expect(why.getByText(t('spaces.exposure.rawLink'))).toBeVisible();
  await expectAccessible(eve);
  await eve.keyboard.press('Escape');
  const raw = await eve.goto(at(`/a/${notesId}/raw`));
  expect(raw?.status()).toBe(403);
  await expect(eve.getByText(t('spaces.exposure.rawLink'))).toBeVisible();

  // The page's own address answers a frame, and refuses a top-level load.
  const top = await eve.goto(src);
  expect(top?.status()).toBe(403);
  await expect(eve.getByText(t('content.framedOnly.title'))).toBeVisible();
  const framed = await eve.context().request.get(src, { headers: { 'sec-fetch-dest': 'iframe' } });
  expect(framed.status()).toBe(200);
  expect(framed.headers()['content-security-policy']).toContain(
    `frame-ancestors 'self' ${SPACES_ORIGIN}`,
  );

  // An admin approves her; the three admin pages of this version are accessible, and so are
  // the questions Users asks about a person's limits and about deleting their content.
  const ada = await person(browser, 'ada');
  await approve(ada, 'Eve Example');
  await expectAccessible(ada);
  const moreFor = ada.getByRole('button', {
    name: t('web.admin.more', { name: 'Eve Example' }),
  });
  await moreFor.click();
  await ada.getByRole('menuitem', { name: t('web.admin.quota.item') }).click();
  const limits = ada.getByRole('dialog', {
    name: t('web.admin.quota.title', { name: 'Eve Example' }),
  });
  await expect(limits).toBeVisible();
  await expectAccessible(ada);
  await ada.keyboard.press('Escape');
  await expect(limits).toBeHidden();
  await moreFor.click();
  await ada.getByRole('menuitem', { name: t('web.admin.purge.item') }).click();
  const purge = ada.getByRole('alertdialog', {
    name: t('web.admin.purge.title', { name: 'Eve Example' }),
  });
  await expect(purge.getByRole('button', { name: t('web.purge.button') })).toBeDisabled();
  await expectAccessible(ada);
  await ada.keyboard.press('Escape');
  await expect(purge).toBeHidden();
  await ada.goto(at('/admin/share-links'));
  await expect(ada.getByText(t('web.admin.links.empty'))).toBeVisible();
  await expectAccessible(ada);
  await ada.goto(at('/admin/lookup'));
  await expect(ada.getByLabel(t('web.admin.lookup.field'))).toBeVisible();
  await expectAccessible(ada);

  // She makes a link that allows comments, and a visitor opens it in the share viewer.
  await eve.goto(at(`/a/${notesId}`));
  const link = await createShareLink(eve, { comments: true });
  const guest = await visitor(browser);
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: 'Eve notes' })).toBeVisible();
  await expect(guest.getByRole('link', { name: t('web.policy.reportAbuse') })).toHaveAttribute(
    'href',
    'mailto:abuse@example.test',
  );
  await expectAccessible(guest);

  // The raw page opens as content, and so does a page's own address opened as a page.
  const rawNow = await eve.goto(at(`/a/${notesId}/raw`));
  expect(rawNow?.status()).toBe(200);
  await expect(eve).toHaveURL(/\/c\//);
  await expect(eve.getByRole('heading', { name: 'Eve notes' })).toBeVisible();
  const topNow = await eve.goto(await reviewSrc(eve, notesId));
  expect(topNow?.status()).toBe(200);

  // An admin finds the link's owner from the address, and takes approval back.
  await ada.goto(at('/admin/lookup'));
  await ada.getByLabel(t('web.admin.lookup.field')).fill(link);
  await ada.getByRole('button', { name: t('web.admin.lookup.submit') }).click();
  const found = ada.getByRole('region', { name: t('web.admin.lookup.kind.share_link') });
  await expect(found.locator(`dt:text-is("${t('web.admin.links.col.owner')}") + dd`)).toContainText(
    'Eve Example',
  );
  await expectAccessible(ada);
  await ada.goto(at('/admin/share-links'));
  await expect(ada.getByText('Eve Example').first()).toBeVisible();
  await expectAccessible(ada);

  const approval = await approvalSwitch(ada, 'Eve Example');
  await approval.click();
  const asking = ada.getByRole('alertdialog', {
    name: t('web.admin.approval.removeTitle', { name: 'Eve Example' }),
  });
  const saved = personSaved(ada);
  await asking.getByRole('button', { name: t('web.admin.approval.removeConfirm') }).click();
  await saved;
  await expect(approval).not.toBeChecked();

  // Her link stops opening at once; the page says so, and where to report abuse.
  await guest.reload();
  await expect(guest.getByRole('heading', { name: t('share.gone.title') })).toBeVisible();
  await expect(guest.getByRole('link', { name: 'abuse@example.test' })).toBeVisible();
  await expectAccessible(guest);
});

test('acceptance 9: project members', async ({ browser }) => {
  const ada = await person(browser, 'ada');
  await approve(ada, 'Eve Example');

  // Bob has two projects, a page in each.
  const bob = await person(browser, 'bob');
  const launch = await createProject(bob, 'Launch');
  const launchPage = await publishInline(
    bob,
    {
      'index.html': html(
        'Launch page',
        '<h1>Launch page</h1><p>We ship <span id="date">on Friday</span>.</p>',
      ),
    },
    { project_id: launch },
  );
  const secret = await createProject(bob, 'Q');
  const secretPage = await publishInline(
    bob,
    { 'index.html': html('Secret', '<h1>Secret</h1>') },
    { project_id: secret },
  );

  // Bob lets Eve into Launch as a viewer.
  await bob.goto(at(`/projects/${launch}`));
  const members = await openMembers(bob, 'Launch');
  await members.getByLabel(t('web.members.email'), { exact: true }).fill('eve@example.test');
  await members.getByRole('button', { name: t('web.members.add'), exact: true }).click();
  await expect(
    members
      .getByRole('list', { name: t('web.members.listLabel') })
      .getByText('Eve Example', { exact: true }),
  ).toBeVisible();
  await expectAccessible(bob);

  // Eve sees Launch shared with her, and not Q.
  const eve = await person(browser, 'eve');
  const bar = sidebar(eve);
  await expect(bar.getByRole('heading', { name: t('web.sidebar.shared') })).toBeVisible();
  const shared = bar.getByRole('link', { name: /^Launch/ });
  await expect(shared).toContainText(
    t('web.sidebar.sharedBy', { owner: 'Bob Example', role: t('web.role.viewer') }),
  );
  await expect(bar.getByText('Q', { exact: true })).toHaveCount(0);
  await unavailableText(eve, secretPage.artifact_id);

  // As a viewer she cannot publish: no Upload on the page, and the server says why.
  await eve.goto(at(`/projects/${launch}`));
  await expect(eve.getByRole('heading', { name: 'Launch' })).toBeVisible();
  await expect(
    eve.getByText(t('web.project.sharedViewer', { owner: 'Bob Example' })),
  ).toBeVisible();
  await expect(eve.getByRole('button', { name: t('web.upload.action'), exact: true })).toHaveCount(
    0,
  );
  const refused = await apiCall<{ error: { details?: { reason?: string } } }>(
    eve,
    'POST',
    '/api/v1/publish/inline',
    {
      target: { project_id: launch },
      files: [{ path: 'index.html', content: html('Not allowed', '<h1>No</h1>') }],
    },
  );
  expect(refused.status).toBe(403);
  expect(refused.json.error.details?.reason).toBe('role');

  // She sees who else is in Launch, by name only.
  const names = await openMembers(eve, 'Launch');
  const people = names.getByRole('list', { name: t('web.members.listLabel') });
  await expect(people).toContainText('Bob Example');
  await expect(people).toContainText('Eve Example');
  await expect(names.getByText('@example.test')).toHaveCount(0);
  await expectAccessible(eve);
  await eve.keyboard.press('Escape');
  await expect(names).toBeHidden();

  // She can still read what is there, and comment on it.
  await eve.goto(at(`/a/${launchPage.artifact_id}`));
  await comment(eve, '#date', 'Is Friday final?');
  await expect(
    eve.locator('article[data-thread-id]', { hasText: 'Is Friday final?' }),
  ).toBeVisible();
  await eve.goto(at('/'));
  await expect(bar.getByRole('heading', { name: t('web.sidebar.shared') })).toBeVisible();
  await expectAccessible(eve);

  // Bob makes her an editor: she can upload now.
  const role = members.getByRole('combobox', {
    name: t('web.members.roleFor', { name: 'Eve Example' }),
  });
  const changed = bob.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/members/'),
  );
  await role.click();
  await bob.getByRole('option', { name: t('web.role.editor') }).click();
  await changed;
  await eve.goto(at(`/projects/${launch}`));
  await expect(
    eve.getByRole('button', { name: t('web.upload.action'), exact: true }),
  ).toBeVisible();

  // Editing Launch gives her nothing in Q: writing there is refused as if Q were not there.
  const intoQ = await apiCall<{ error: { code?: string } }>(eve, 'POST', '/api/v1/publish/inline', {
    target: { project_id: secret },
    files: [{ path: 'index.html', content: html('Not here', '<h1>No</h1>') }],
  });
  expect(intoQ.status).toBe(404);
  expect(intoQ.json.error.code).toBe('not_found');
  const overSecret = await apiCall<{ error: { code?: string } }>(
    eve,
    'POST',
    '/api/v1/publish/inline',
    {
      target: { artifact_id: secretPage.artifact_id, expected_version_id: secretPage.version_id },
      files: [{ path: 'index.html', content: html('Secret', '<h1>Not hers</h1>') }],
    },
  );
  expect(overSecret.status).toBe(404);
  expect(overSecret.json.error.code).toBe('not_found');

  // What an editor publishes counts against the project owner's space, not hers.
  const bytesOf = async (page: Page) =>
    (await apiCall<{ usage: { bytes: number } }>(page, 'GET', '/api/v1/me')).json.usage.bytes;
  const bobBefore = await bytesOf(bob);
  const eveBefore = await bytesOf(eve);
  const edit = await publishInline(
    eve,
    { 'index.html': html('Launch notes', '<h1>Launch notes</h1>') },
    { project_id: launch },
  );
  const version = await apiCall<{ current_version: { total_bytes: number } }>(
    eve,
    'GET',
    `/api/v1/artifacts/${edit.artifact_id}`,
  );
  expect(version.json.current_version.total_bytes).toBeGreaterThan(0);
  expect(await bytesOf(bob)).toBe(bobBefore + version.json.current_version.total_bytes);
  expect(await bytesOf(eve)).toBe(eveBefore);
  await bob.goto(at('/settings/usage'));
  await expect(bob.getByText(t('web.usage.storage'), { exact: true })).toBeVisible();
  await expectAccessible(bob);

  // Bob's page is not hers to take outside Pinwall: Bob is not approved, so her link is refused.
  await eve.goto(at(`/a/${launchPage.artifact_id}`));
  await eve.getByRole('button', { name: t('web.review.share'), exact: true }).click();
  const sharing = eve.getByRole('dialog', { name: t('web.share.title', { name: 'Launch page' }) });
  await sharing.getByRole('button', { name: t('web.share.create') }).click();
  await expect(sharing.getByRole('alert')).toHaveText(t('spaces.exposure.shareLinkVersion'));
  await eve.keyboard.press('Escape');
  await expect(sharing).toBeHidden();

  // She shares her own page of Launch and keeps it open; Bob takes her out.
  await eve.goto(at(`/a/${edit.artifact_id}`));
  const link = await createShareLink(eve);
  await expect(eve.locator('[data-annotator="ready"]')).toBeVisible();
  await bob.goto(at(`/projects/${launch}`));
  const again = await openMembers(bob, 'Launch');
  await again
    .getByRole('button', { name: t('web.members.removeFor', { name: 'Eve Example' }) })
    .click();
  await bob
    .getByRole('alertdialog', { name: t('web.members.remove.title') })
    .getByRole('button', { name: t('web.members.remove.confirm') })
    .click();
  await expect(again.getByText('Eve Example', { exact: true })).toHaveCount(0);

  // Her open tab loses the page, and her link stops opening.
  await expect(eve.getByRole('heading', { name: t('web.artifact.unavailable') })).toBeVisible({
    timeout: 30_000,
  });
  const guest = await visitor(browser);
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: t('share.gone.title') })).toBeVisible();

  // Q was never hers, and Launch is not any more.
  await unavailableText(eve, secretPage.artifact_id);
  await eve.goto(at('/'));
  await expect(bar.getByRole('list', { name: t('web.sidebar.projects') })).toBeVisible();
  await expect(bar.getByRole('heading', { name: t('web.sidebar.shared') })).toHaveCount(0);
  await expect(bar.getByRole('link', { name: /^Launch/ })).toHaveCount(0);
});
