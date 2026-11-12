import { expect, type Page, test } from '@playwright/test';
import messages from '../../packages/shared/src/i18n/en.json' with { type: 'json' };

const PINWALL_ORIGIN = /^http:\/\/localhost:18096\//;

/** The product's own wording for `key`, with `{{name}}` filled in, so the walks read what people read. */
function t(key: keyof typeof messages, vars: Record<string, string> = {}): string {
  return messages[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
}

/** Fills Keycloak's login form. */
async function keycloakLogin(page: Page, user: string, password: string): Promise<void> {
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

/**
 * Keycloak asks for consent only when the sign-in prompts for it, so this answers "Yes" when that
 * page comes up first, and does nothing when the person lands back on Pinwall.
 */
async function acceptConsentIfShown(page: Page): Promise<void> {
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  const shown = await Promise.race([
    yes.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true),
    page.waitForURL(PINWALL_ORIGIN, { timeout: 10_000 }).then(() => false),
  ]).catch(() => false);
  if (shown) await yes.click();
}

/** Starts from Pinwall's sign-in page, takes the single sign-on link and signs in at Keycloak. */
async function signInWithKeycloak(page: Page, user: string, password: string): Promise<void> {
  await page.goto('/signin');
  await page.getByRole('link', { name: t('web.signin.oidc', { name: 'Keycloak' }) }).click();
  await keycloakLogin(page, user, password);
  await acceptConsentIfShown(page);
  await expect(page).toHaveURL(PINWALL_ORIGIN);
}

/** What `GET /api/v1/me` says about the browser's session, asked from inside the page. */
function readMe(page: Page): Promise<unknown> {
  return page.evaluate(async () => (await fetch('/api/v1/me')).json());
}

// Playwright gives every test a fresh browser context, so none of them starts with a Keycloak
// session left by another.

test('an admin from pinwall-admins signs in as admin', async ({ page }) => {
  await signInWithKeycloak(page, 'ada', 'ada-e2e-password');
  expect(await readMe(page)).toMatchObject({
    kind: 'oidc',
    role: 'admin',
    email: 'ada@example.test',
  });

  await page.goto('/admin/users');
  await expect(page.getByText('ada@example.test')).toBeVisible();
});

test('a member from pinwall-members signs in as member', async ({ page }) => {
  await signInWithKeycloak(page, 'bob', 'bob-e2e-password');
  expect(await readMe(page)).toMatchObject({
    kind: 'oidc',
    role: 'member',
    email: 'bob@example.test',
  });

  await page.goto('/admin/users');
  await expect(page.getByText(t('auth.adminOnly'))).toBeVisible();
});

/** Eve has an account at Keycloak and no group, so Pinwall refuses her and says who she is. */
async function expectNoAccessPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: t('oidc.noAccess.title') })).toBeVisible();
  await expect(page.getByText('Eve Example', { exact: true })).toBeVisible();
  await expect(page.getByText('eve@example.test')).toBeVisible();
}

/**
 * Takes "Use a different account" on the no-access page. Keycloak has to ask who is signing in,
 * not sign Eve in again without asking; then Bob, a member, signs in.
 */
async function switchToBob(page: Page): Promise<void> {
  await page.getByRole('link', { name: t('oidc.noAccess.switch') }).click();
  await expect(page.locator('#username')).toBeVisible();
  await keycloakLogin(page, 'bob', 'bob-e2e-password');
  await acceptConsentIfShown(page);
  await expect(page).toHaveURL(PINWALL_ORIGIN);
  expect(await readMe(page)).toMatchObject({ kind: 'oidc', role: 'member' });
}

test('an unadmitted user sees who signed in and can switch accounts', async ({ page }) => {
  // The refusal is a page on Pinwall's own origin, which the helper's landing check accepts.
  await signInWithKeycloak(page, 'eve', 'eve-e2e-password');
  await expectNoAccessPage(page);
  // Pinwall asks for offline_access by default, and Keycloak keeps no single-sign-on session for
  // a sign-in that does. Eve's walk above left none, so the login form comes back whatever the
  // prompt says; the next test is the one where Keycloak has a session to reuse.
  await switchToBob(page);
});

test('an unadmitted user who is already signed in at Keycloak can switch accounts', async ({
  page,
}) => {
  // Eve signs in at Keycloak itself first, as she would for another application of the same
  // identity provider, so Keycloak holds a single-sign-on session for her.
  await page.goto('http://localhost:18180/realms/pinwall/account');
  await keycloakLogin(page, 'eve', 'eve-e2e-password');
  await expect(page).toHaveURL(/^http:\/\/localhost:18180\/realms\/pinwall\/account/);

  // Pinwall's sign-in reuses that session without a form, and refuses her.
  await page.goto('/signin');
  await page.getByRole('link', { name: t('web.signin.oidc', { name: 'Keycloak' }) }).click();
  await expect(page).toHaveURL(PINWALL_ORIGIN);
  await expectNoAccessPage(page);

  // Reusing that session again is the one thing "Use a different account" must not do.
  await switchToBob(page);
});
