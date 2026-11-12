import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { makeSite } from './support/site.ts';

const OWNER_NAME = 'Ada';
const OWNER_PASSWORD = 'correct horse battery staple';
const PROJECT_NAME = 'Launch site';

/** What the first walk creates and the second one visits. */
const made: { projectId?: string; artifactId?: string } = {};

let siteDir: string;

test.beforeAll(async () => {
  siteDir = await mkdtemp(join(tmpdir(), 'pinwall-e2e-site-'));
  await makeSite(siteDir);
});

test.afterAll(async () => {
  await rm(siteDir, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

/**
 * The WCAG 2.1 A and AA violations on the page now, reduced to what a person needs to find
 * them: the rule, how bad it is, and the elements.
 */
async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return {
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(' ')),
    })),
  };
}

/** Signs in on `/signin` with the owner's password and waits for the library. */
async function signInWithPassword(page: Page) {
  await page.goto('/signin');
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();
}

/**
 * The key the app takes as "mod": Meta where it believes it runs on an Apple platform, Control
 * elsewhere. It asks the page, because the emulated device decides that, not the host.
 */
async function modifierKey(page: Page): Promise<'Meta' | 'Control'> {
  const apple = await page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
  });
  return apple ? 'Meta' : 'Control';
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: OWNER_NAME }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signin/);
}

test('setup → sign-in → create project → upload a folder → see it in the grid', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  // Setup: a passkey and a password.
  await page.goto(process.env.PINWALL_E2E_SETUP_URL as string);
  await expect(page.getByRole('heading', { name: 'Set up Pinwall' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);
  await page.getByLabel('Your name').fill(OWNER_NAME);
  await expect(page.getByRole('switch', { name: 'Passkey' })).toBeChecked();
  await page.getByRole('switch', { name: 'Password' }).check();
  await page.getByLabel('Choose a password').fill(OWNER_PASSWORD);
  await page.getByLabel('Confirm password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();
  await expect(page.getByText('No artifacts yet')).toBeVisible();

  // Sign out: the sign-in page is accessible too.
  await signOut(page);
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);

  // Password sign-in.
  await signInWithPassword(page);
  await expect(page).toHaveURL(/\/$/);

  // A project with instructions.
  await page.getByRole('button', { name: 'New project' }).click();
  const newProject = page.getByRole('dialog', { name: 'New project' });
  await newProject.getByLabel('Name').fill(PROJECT_NAME);
  await newProject.getByLabel('Instructions for agents').fill('Use English. Brand color #4b56e3.');
  await newProject.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();
  made.projectId = /\/projects\/([^/?#]+)/.exec(page.url())?.[1];
  expect(made.projectId).toBeTruthy();

  // Upload a folder through the file chooser the dialog opens.
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Upload to ${PROJECT_NAME}` });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: 'Choose a folder' }).click(),
  ]);
  await chooser.setFiles(siteDir);
  await expect(page.getByText('Published “E2E Site” v1')).toBeVisible();

  // The grid shows it, with its cover image.
  const card = page.getByRole('link', { name: 'E2E Site' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('v1');
  made.artifactId = /\/a\/([^/?#]+)/.exec((await card.getAttribute('href')) ?? '')?.[1];
  expect(made.artifactId).toBeTruthy();
  const cover = card.locator('img');
  await cover.scrollIntoViewIfNeeded();
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  // The list view sticks across a reload.
  await page.getByRole('radio', { name: 'List' }).click();
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Grid' })).not.toBeChecked();
  await expect(card).toBeVisible();
  expect((await axe(page)).violations).toEqual([]);

  // Passkey sign-in with the virtual authenticator.
  await signOut(page);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // Search with the keyboard, then open the artifact.
  await page.keyboard.press(`${await modifierKey(page)}+K`);
  await page.getByRole('combobox', { name: 'Search artifacts' }).fill('e2e');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/a/${made.artifactId}$`));
  // The review screen opens on it; its menu links the raw page.
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open raw page' })).toHaveAttribute(
    'href',
    `/a/${made.artifactId}/raw`,
  );
  await page.keyboard.press('Escape');

  // The tab icon and the install manifest are served.
  const favicon = await page.request.get('/favicon.svg');
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()['content-type']).toContain('image/svg+xml');
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toBe('application/manifest+json');
  expect(await manifest.json()).toMatchObject({ name: 'Pinwall', start_url: '/' });
});

test('main pages have no accessibility violations', async ({ page, context }) => {
  // Ten pages, two viewports, two color schemes: forty page loads, each scanned.
  test.setTimeout(120_000);
  expect(made.projectId, 'the walk above creates the project').toBeTruthy();
  expect(made.artifactId, 'the walk above creates the artifact').toBeTruthy();
  const paths = [
    '/',
    `/projects/${made.projectId}`,
    '/search?q=e2e',
    `/a/${made.artifactId}`,
    '/settings/profile',
    '/settings/security',
    '/settings/tokens',
    '/connect',
    '/admin/users',
    '/admin/config',
  ];
  const viewports = [
    { width: 1280, height: 800 },
    { width: 360, height: 740 },
  ];
  const schemes = ['light', 'dark'] as const;
  let lightCanvas = '';

  await signInWithPassword(page);
  for (const viewport of viewports) {
    for (const scheme of schemes) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      // The scheme must take effect, or the dark runs would only repeat the light ones.
      await page.goto('/');
      await expect(page.locator('main h1').first()).toBeVisible();
      const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if (scheme === 'light') lightCanvas = canvas;
      else
        expect(canvas, `dark canvas differs from light at ${viewport.width} px`).not.toBe(
          lightCanvas,
        );
      for (const path of paths) {
        const where = `${path} at ${viewport.width} px, ${scheme}`;
        await page.goto(path);
        await expect(page.locator('main h1').first(), where).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect((await axe(page)).violations, where).toEqual([]);
        if (viewport.width <= 360) {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          expect(overflow, `${where}: horizontal overflow`).toBeLessThanOrEqual(0);
        }
      }
    }
  }

  // A window wide enough for the users table, which the sizes above never show.
  await page.setViewportSize({ width: 1600, height: 900 });
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/admin/users');
    await expect(page.getByRole('table', { name: 'Users' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect((await axe(page)).violations, `users table at 1600 px, ${scheme}`).toEqual([]);
  }

  // Keyboard focus is visible on the first five stops of the library.
  await page.setViewportSize(viewports[0] as { width: number; height: number });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();
  for (let stop = 1; stop <= 5; stop += 1) {
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline, `Tab stop ${stop} has focus`).not.toBeNull();
    expect(outline?.style, `Tab stop ${stop} outline style`).not.toBe('none');
    expect(outline?.width, `Tab stop ${stop} outline width`).toBeGreaterThan(0);
  }

  // Signed out: the sign-in page.
  await context.clearCookies();
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/signin');
    await expect(page.getByRole('heading', { name: 'Sign in to Pinwall' })).toBeVisible();
    expect((await axe(page)).violations, `/signin, ${scheme}`).toEqual([]);
  }
});

test('the app loads under its own content security policy without a violation', async ({
  page,
}) => {
  // The browser reports a blocked script, and also an eval that the code tried and caught, as a
  // securitypolicyviolation event. The function outlives page loads; the listener is in place
  // before the first script of each one runs.
  const violations: string[] = [];
  await page.exposeFunction('reportViolation', (detail: string) => violations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { reportViolation(detail: string): void })
        .reportViolation;
      report(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}`);
    });
  });
  // Chrome also writes a blocked script to the console. (A signed-out visit's 401 from /me is
  // expected, so only messages about the policy count.)
  const problems: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to|unsafe-eval/i.test(message.text())) {
      problems.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

  const response = await page.goto('/signin');
  expect(response?.headers()['content-security-policy'], 'served with a policy').toContain(
    "script-src 'self'",
  );
  await expect(page.getByRole('heading', { name: 'Sign in to Pinwall' })).toBeVisible();
  await signInWithPassword(page);
  await page.goto('/connect');
  await expect(page.locator('main h1').first()).toBeVisible();

  expect(violations).toEqual([]);
  expect(problems).toEqual([]);
});

test('a picked folder is asked about its hidden files, and never sends .git', async ({ page }) => {
  expect(made.projectId, 'the walk above creates the project').toBeTruthy();
  const folder = await mkdtemp(join(tmpdir(), 'pinwall-e2e-hidden-'));
  try {
    await mkdir(join(folder, '.git'));
    await writeFile(
      join(folder, 'index.html'),
      '<!doctype html><html lang="en"><title>Hidden Files Site</title><h1>Hello</h1></html>',
    );
    await writeFile(join(folder, '.env'), 'TOKEN=not-for-publishing\n');
    await writeFile(join(folder, '.git', 'config'), '[remote "origin"]\n');
    await writeFile(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await signInWithPassword(page);
    await page.goto(`/projects/${made.projectId}`);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page
        .getByRole('dialog', { name: `Upload to ${PROJECT_NAME}` })
        .getByRole('button', { name: 'Choose a folder' })
        .click(),
    ]);
    await chooser.setFiles(folder);

    // Nothing is sent yet: the question lists .env and not the .git files, with Skip focused.
    const question = page.getByRole('dialog', { name: 'Include hidden files?' });
    await expect(question).toBeVisible();
    await expect(question.getByRole('listitem')).toHaveText([/\.env$/]);
    // The upload dialog has finished closing, and its closing did not take the focus back.
    await expect(
      page.getByRole('dialog', { name: `Upload to ${PROJECT_NAME}`, includeHidden: true }),
    ).toHaveCount(0);
    await expect(question.getByRole('button', { name: 'Skip hidden files' })).toBeFocused();
    expect((await axe(page)).violations).toEqual([]);

    await question.getByRole('button', { name: 'Skip hidden files' }).click();
    await expect(page.getByText('Published “Hidden Files Site” v1')).toBeVisible();
    await expect(page.getByText('2 files in version-control folders')).toBeVisible();
    await expect(page.getByText('1 hidden file was left out.')).toBeVisible();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
