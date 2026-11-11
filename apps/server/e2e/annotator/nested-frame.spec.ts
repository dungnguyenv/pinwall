import { type PageToViewerMessage, parsePageMessage } from '@pinwall/shared/protocol';
import { expect, type Locator, type Page, test } from '@playwright/test';

/** Where fixture-server.ts serves the viewer. */
const VIEWER_URL = 'http://127.0.0.1:18472/';

/** What `viewer.html` puts on `window`. */
interface ViewerHook {
  __pinwallTest: { received: unknown[]; broadcast(msg: object): void };
}

/** Every annotator message the viewer has received so far, from any frame of the content. */
async function received(page: Page): Promise<PageToViewerMessage[]> {
  const raw = await page.evaluate(
    () => (globalThis as unknown as ViewerHook).__pinwallTest.received,
  );
  return raw.flatMap((data) => parsePageMessage(data) ?? []);
}

/** The messages of one `type`, narrowed to that type. */
async function receivedOf<T extends PageToViewerMessage['type']>(
  page: Page,
  type: T,
): Promise<Extract<PageToViewerMessage, { type: T }>[]> {
  const all = await received(page);
  return all.filter((m): m is Extract<PageToViewerMessage, { type: T }> => m.type === type);
}

/** Sends `msg` from the viewer to the window of the content frame and to every frame below it. */
function broadcast(page: Page, msg: object): Promise<void> {
  return page.evaluate(
    (m) => (globalThis as unknown as ViewerHook).__pinwallTest.broadcast(m),
    msg,
  );
}

test('pins a comment on text inside a nested frame', async ({ page }) => {
  await page.goto(VIEWER_URL);
  const content = page.frameLocator('#content');
  const inner = content.frameLocator('#inner');
  const locked = content.frameLocator('#locked');

  // Both frames whose page lets the annotator run say so; the viewer never has to guess.
  await expect.poll(async () => (await receivedOf(page, 'ready')).length).toBe(2);
  const readies = await receivedOf(page, 'ready');
  expect(readies.map((m) => m.page).sort()).toEqual(['', 'inner.html']);
  const innerId = readies.find((m) => m.page === 'inner.html')?.frameId;
  expect(innerId).toBeDefined();

  // The locked frame has finished loading and got the tag right after its own CSP meta, which
  // kept the script from running: nothing set up the annotator there, so it can send no `ready`.
  await expect(
    locked.locator('head > meta[http-equiv] + script[data-pinwall-annotator]'),
  ).toHaveCount(1);
  const frames = page.frames().filter((frame) => frame.url().endsWith('/locked.html'));
  expect(frames).toHaveLength(1);
  await frames[0]?.waitForLoadState('load');
  const annotatorRuns = (frameBody: Locator) =>
    frameBody.evaluate(
      () =>
        (globalThis as unknown as { __pinwallAnnotator?: unknown }).__pinwallAnnotator !==
        undefined,
    );
  expect(await annotatorRuns(locked.locator('body'))).toBe(false);
  expect(await annotatorRuns(inner.locator('body'))).toBe(true);
  expect(await receivedOf(page, 'ready')).toHaveLength(2);

  // Comment mode, then drag across the words inside the nested frame.
  await broadcast(page, { pinwall: 1, type: 'set-mode', mode: 'comment' });
  const target = inner.locator('#target');
  const box = await target.boundingBox();
  if (box === null) throw new Error('#target has no box');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await receivedOf(page, 'anchor-picked')).length).toBe(1);
  const [picked] = await receivedOf(page, 'anchor-picked');
  if (picked === undefined) throw new Error('no anchor was picked');
  expect(picked).toMatchObject({
    frameId: innerId,
    anchor: {
      kind: 'text',
      page: 'inner.html',
      dom: { path: '#target' },
      quote: { exact: 'hello to Pinwall' },
    },
  });
  expect(picked.anchor.quote?.prefix.endsWith('The nested frame says ')).toBe(true);
  expect(picked.anchor.quote?.suffix.startsWith(' today.')).toBe(true);

  // Back to browsing; the thread's pin appears where the text is, and moves nothing.
  await broadcast(page, { pinwall: 1, type: 'set-mode', mode: 'browse' });
  await broadcast(page, {
    pinwall: 1,
    type: 'show-anchors',
    anchors: [{ id: 'c1', number: 1, resolved: false, anchor: picked.anchor }],
  });
  await expect
    .poll(async () =>
      (await receivedOf(page, 'anchors-placed')).map((m) => [m.frameId === innerId, m.results]),
    )
    .toContainEqual([true, [{ id: 'c1', found: true }]]);
  const pin = inner.locator('pinwall-overlay [data-pin-id="c1"]');
  await expect(pin).toHaveText('1');
  expect(await target.boundingBox()).toEqual(box);

  await pin.click();
  await expect
    .poll(async () => (await receivedOf(page, 'pin-clicked')).some((m) => m.id === 'c1'))
    .toBe(true);
});
