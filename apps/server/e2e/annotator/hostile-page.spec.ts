// The annotator on pages that make its job hard, in a real browser: what jsdom cannot show
// (layout, scroll size, trusted input).
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { broadcast, receivedOf, VIEWER_URL } from './viewer.ts';

/** Opens the viewer framing `file` and waits for that page's annotator to say it is ready. */
async function openPage(page: Page, file: string): Promise<FrameLocator> {
  await page.goto(`${VIEWER_URL}?page=${encodeURIComponent(file)}`);
  await expect
    .poll(async () => (await receivedOf(page, 'ready')).map((m) => m.page))
    .toEqual([file]);
  return page.frameLocator('#content');
}

/** The scroll size of the framed document. */
function scrollSize(content: FrameLocator): Promise<number[]> {
  return content.locator('html').evaluate((root) => [root.scrollWidth, root.scrollHeight]);
}

/** A text anchor on `exact`, or an element anchor on `path`, of `page`. */
function anchorOf(page: string, target: { exact: string } | { path: string }) {
  return {
    page,
    ...('exact' in target
      ? { kind: 'text', quote: { exact: target.exact, prefix: '', suffix: '' } }
      : { kind: 'element', dom: { path: target.path } }),
    position: { x: 0, y: 0 },
    viewport: { width: 1280 },
  };
}

test('highlights and outlines of clipped content never grow the page', async ({ page }) => {
  const content = await openPage(page, 'clipped.html');
  const before = await scrollSize(content);

  const targets = [
    { exact: 'Offscreen slide words' },
    { path: '#far' },
    { exact: 'Deep panel words' },
    { path: '#deep' },
  ];
  await broadcast(page, {
    pinwall: 1,
    type: 'show-anchors',
    anchors: targets.map((target, i) => ({
      id: `c${i + 1}`,
      number: i + 1,
      resolved: false,
      anchor: anchorOf('clipped.html', target),
    })),
  });
  await expect
    .poll(async () => (await receivedOf(page, 'anchors-placed')).at(-1)?.results.length)
    .toBe(4);
  expect((await receivedOf(page, 'anchors-placed')).at(-1)?.results.every((r) => r.found)).toBe(
    true,
  );
  await expect(content.locator('pinwall-overlay [data-pin-id]')).toHaveCount(4);
  expect(await scrollSize(content)).toEqual(before);
});

test('the hover outline of a wide element never grows the page', async ({ page }) => {
  const content = await openPage(page, 'clipped.html');
  const before = await scrollSize(content);
  await broadcast(page, { pinwall: 1, type: 'set-mode', mode: 'comment' });

  // Below the slide text, inside the 4000 px wide track that its 300 px box clips.
  const box = await content.locator('#track-box').boundingBox();
  if (box === null) throw new Error('#track-box has no box');
  let nudge = 0;
  await expect
    .poll(async () => {
      // set-mode has no answer: move until comment mode draws the outline.
      nudge = 1 - nudge;
      await page.mouse.move(box.x + 250 + nudge, box.y + 100);
      return content.locator('pinwall-overlay .hover[data-on]').count();
    })
    .toBe(1);
  expect(await scrollSize(content)).toEqual(before);
});
