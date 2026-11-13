import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import messages from '../../packages/shared/src/i18n/en.json' with { type: 'json' };

/** The second Pinwall of this suite: personal mode, open sign-up, share links by approval. */
export const SPACES_ORIGIN = 'http://localhost:18097';

/** The product's own wording for `key`, with `{{name}}` filled in, so the walks read what people read. */
export function t(key: keyof typeof messages, vars: Record<string, string> = {}): string {
  return messages[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
}

/** Fills Keycloak's login form. */
export async function keycloakLogin(page: Page, user: string, password: string): Promise<void> {
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

/** Whether `url` is a page of the Pinwall at `origin`. */
function isOn(origin: string): (url: URL) => boolean {
  return (url) => url.origin === origin;
}

/**
 * Keycloak asks for consent only when the sign-in prompts for it, so this answers "Yes" when that
 * page comes up first, and does nothing when the person lands back on the Pinwall at `origin`.
 */
export async function acceptConsentIfShown(page: Page, origin: string): Promise<void> {
  const yes = page.getByRole('button', { name: 'Yes', exact: true });
  const shown = await Promise.race([
    yes.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true),
    page.waitForURL(isOn(origin), { timeout: 10_000 }).then(() => false),
  ]).catch(() => false);
  if (shown) await yes.click();
}

/**
 * Starts from the sign-in page of the Pinwall at `origin`, takes the single sign-on link and
 * signs in at Keycloak as `user`, whose password the realm sets to `<user>-e2e-password`.
 */
export async function signInWithKeycloak(
  page: Page,
  origin: string,
  user: 'ada' | 'bob' | 'eve',
): Promise<void> {
  await page.goto(new URL('/signin', origin).href);
  await page.getByRole('link', { name: t('web.signin.oidc', { name: 'Keycloak' }) }).click();
  await keycloakLogin(page, user, `${user}-e2e-password`);
  await acceptConsentIfShown(page, origin);
  await expect(page).toHaveURL(isOn(origin));
}

/**
 * A person in a browser of their own, signed in to the Pinwall at `origin`. Cookies on
 * `localhost` ignore the port, and Keycloak keeps its own, so two people must never share a
 * context: each gets a fresh one, which the caller closes.
 */
export async function personIn(
  browser: Browser,
  origin: string,
  user: 'ada' | 'bob' | 'eve',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWithKeycloak(page, origin, user);
  return { context, page };
}

/**
 * The WCAG 2.1 A and AA violations on the page now, reduced to what a person needs to find
 * them: the rule, how bad it is, and the elements. A walk expects the list to be empty.
 */
export async function axe(page: Page) {
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
