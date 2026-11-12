import { expect, type Page, test } from '@playwright/test';
import { apiCall, bootstrap, publishInline } from '../support/in-page-api.ts';
import { reviewServer } from '../support/review-servers.ts';

declare global {
  interface Window {
    /** Set by the test on the review tab; a reload of the app would drop it. */
    __noReload?: boolean;
  }
}

/** The artifact of both versions: only the heading's color changes between them. */
const PAGE = (color: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pricing</title>
  </head>
  <body>
    <h1 style="color:${color}">Pricing</h1>
    <p id="p">The plan costs <span id="price">10 USD per month</span> for everyone.</p>
  </body>
</html>
`;

/** Collects the Content Security Policy reports the page logs to its console, frames included. */
function cspErrors(page: Page): string[] {
  const found: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) found.push(m.text());
  });
  return found;
}

test('a comment pinned on v1 follows the artifact to v2 and shows resolved in v2', async ({
  page,
  context,
}) => {
  // A second tab does the agent's part, so the review tab is never touched by it.
  const api = await context.newPage();
  await bootstrap(api, reviewServer(test.info().project.name));
  const v1 = await publishInline(api, { 'index.html': PAGE('#222222') });

  await page.goto(`/a/${v1.artifact_id}`);
  await page.evaluate(() => {
    window.__noReload = true;
  });
  await expect(page.locator('[data-annotator="ready"]')).toBeVisible();

  // Pin a comment on the price by selecting its words in comment mode.
  await page.getByRole('button', { name: 'Comment mode' }).click();
  await expect(page.getByRole('button', { name: 'Comment mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const frame = page.frameLocator('iframe[sandbox]');
  const box = await frame.locator('#price').boundingBox();
  if (box === null) throw new Error('The price is not on screen');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Make the price bold');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  const card = page.locator('article[data-thread-id]', { hasText: 'Make the price bold' });
  const id = await card.getAttribute('data-thread-id');
  if (id === null) throw new Error('The thread card has no id');
  const pin = frame.locator(`pinwall-overlay [data-pin-id="${id}"]`);
  await expect(pin).toHaveText('1');
  const before = await page.locator('iframe[sandbox]').getAttribute('src');
  if (before === null) throw new Error('The review frame has no src');

  // v2 arrives through the API while the tab is open: the tab follows it without a reload.
  await publishInline(
    api,
    { 'index.html': PAGE('#c00000') },
    { artifact_id: v1.artifact_id, expected_version_id: v1.version_id },
  );
  await expect(page.getByRole('button', { name: 'Choose version, showing v2' })).toBeVisible();
  expect(await page.evaluate(() => window.__noReload)).toBe(true);
  await expect(page.locator('iframe[sandbox]')).not.toHaveAttribute('src', before);
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(192, 0, 0)');

  // The pin is anchored on v2's page too.
  await expect(pin).toHaveText('1');
  await expect(card).not.toContainText("Couldn't find this");

  // The agent resolves the thread; the open tab says where.
  expect((await apiCall(api, 'POST', `/api/v1/comments/${id}/resolve`, {})).status).toBe(200);
  await expect(card).toContainText('Resolved in v2');
  await expect(pin).toHaveAttribute('data-resolved', /.*/);
  expect(await page.evaluate(() => window.__noReload)).toBe(true);
});

test('the review page fits a 360 px phone', async ({ page, context }) => {
  const csp = cspErrors(page);
  const api = await context.newPage();
  await bootstrap(api, reviewServer(test.info().project.name));
  const v1 = await publishInline(api, { 'index.html': PAGE('#222222') });

  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/a/${v1.artifact_id}`);
  await expect(page.locator('[data-annotator="ready"]')).toBeVisible();
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);

  await page.getByRole('button', { name: /^Comments(, \d+ open)?$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Comments' })).toBeVisible();
  expect(await fits()).toBe(true);
  expect(csp).toEqual([]);
});
