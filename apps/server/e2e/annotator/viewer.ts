// What the annotator browser tests share: talking to the test viewer (viewer.html) that
// fixture-server.ts serves around a review grant.
import { type PageToViewerMessage, parsePageMessage } from '@pinwall/shared/protocol';
import type { Page } from '@playwright/test';

/** Where fixture-server.ts serves the viewer; `?page=<file>` frames that page of the artifact. */
export const VIEWER_URL = 'http://127.0.0.1:18472/';

/** What `viewer.html` puts on `window`. */
interface ViewerHook {
  __pinwallTest: { received: unknown[]; broadcast(msg: object): void };
}

/** Every annotator message the viewer has received so far, from any frame of the content. */
export async function received(page: Page): Promise<PageToViewerMessage[]> {
  const raw = await page.evaluate(
    () => (globalThis as unknown as ViewerHook).__pinwallTest.received,
  );
  return raw.flatMap((data) => parsePageMessage(data) ?? []);
}

/** The messages of one `type`, narrowed to that type. */
export async function receivedOf<T extends PageToViewerMessage['type']>(
  page: Page,
  type: T,
): Promise<Extract<PageToViewerMessage, { type: T }>[]> {
  const all = await received(page);
  return all.filter((m): m is Extract<PageToViewerMessage, { type: T }> => m.type === type);
}

/** Sends `msg` from the viewer to the window of the content frame and to every frame below it. */
export function broadcast(page: Page, msg: object): Promise<void> {
  return page.evaluate(
    (m) => (globalThis as unknown as ViewerHook).__pinwallTest.broadcast(m),
    msg,
  );
}
