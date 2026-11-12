import { readFileSync } from 'node:fs';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { CONTENT_SANDBOX } from '../../apps/web/src/review/frame/sandbox.ts';
import { fidelitySite } from '../support/fidelity-site.ts';
import { bootstrap, publishUpload } from '../support/in-page-api.ts';
import { reviewServer } from '../support/review-servers.ts';

declare global {
  interface Window {
    /** Set by the fixture's entry page; a full page load would reset it. */
    __marker?: string;
  }
}

/** What a person sees and gets from the fixture, the same wherever it is shown. */
interface Observed {
  title: string;
  marker: string | undefined;
  /** Every nested frame, depth first: its URL relative to the artifact, and its first paragraph. */
  frames: { path: string; text: string | null }[];
  video: { ready: boolean; videoWidth: number };
  /** After following `#to-s3`. */
  anchor: { hash: string; top: boolean; sameDocument: boolean };
  /** After following `#to-about`. */
  link: { path: string; h1: string | null };
}

/** How long the video may take to have a frame to show. */
const VIDEO_MS = 15_000;

/** Waits until both nested frames of the entry page have loaded their paragraph. */
async function nestedFramesLoaded(root: Frame): Promise<void> {
  const inner = root.frameLocator('#f1');
  await inner.locator('#inner').waitFor();
  await inner.frameLocator('#f2').locator('#deeper').waitFor();
}

/** The frames under `root`, depth first. */
function descendants(root: Frame): Frame[] {
  return root.childFrames().flatMap((child) => [child, ...descendants(child)]);
}

/**
 * Looks at the fixture's entry page in `root` and uses it: its title and script, its nested
 * frames, its video, then an in-page anchor and a relative link (which leaves the page). URLs are
 * reported relative to `base`, the artifact's root, so a raw and a review grant compare equal.
 */
async function observe(root: Frame, base: string): Promise<Observed> {
  const relative = (url: string) => (url.startsWith(base) ? url.slice(base.length) : url);
  await nestedFramesLoaded(root);

  const title = await root.title();
  const marker = await root.evaluate(() => window.__marker);
  const frames: Observed['frames'] = [];
  for (const frame of descendants(root)) {
    frames.push({
      path: relative(frame.url()),
      text: await frame.locator('p').first().textContent(),
    });
  }

  const ready = await root
    .waitForFunction(
      () => ((document.getElementById('v') as HTMLVideoElement | null)?.readyState ?? 0) >= 2,
      undefined,
      { timeout: VIDEO_MS },
    )
    .then(
      () => true,
      () => false,
    );
  const videoWidth = await root.evaluate(
    () => (document.getElementById('v') as HTMLVideoElement).videoWidth,
  );

  await root.locator('#to-s3').click();
  await root.waitForFunction(() => location.hash === '#section-3');
  const anchor = await root.evaluate(() => ({
    hash: location.hash,
    top:
      Math.abs((document.getElementById('section-3') as HTMLElement).getBoundingClientRect().top) <=
      1,
    sameDocument: window.__marker === 'entry',
  }));

  await root.locator('#to-about').click();
  await root.waitForURL(`${base}about.html`);
  const link = { path: relative(root.url()), h1: await root.locator('h1').textContent() };

  return { title, marker, frames, video: { ready, videoWidth }, anchor, link };
}

/** Whether Pinwall's comment annotator runs in `frame`. */
function hasAnnotator(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => '__pinwallAnnotator' in window);
}

/** Collects the Content Security Policy reports the page logs to its console, frames included. */
function cspErrors(page: Page): string[] {
  const found: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) found.push(m.text());
  });
  return found;
}

// Acceptance 5.
test('a multi-page artifact behaves the same in review as on its raw link', async ({
  page,
  context,
}) => {
  const api = await context.newPage();
  await bootstrap(api, reviewServer(test.info().project.name));
  const site = fidelitySite(readFileSync(process.env.PINWALL_E2E_VIDEO as string));
  const pub = await publishUpload(api, site);

  const ranges: number[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('media/clip.webm')) ranges.push(r.status());
  });
  const csp = cspErrors(page);

  // The raw link: the bytes as published, and no annotator anywhere.
  const rawResp = await page.goto(`/a/${pub.artifact_id}/raw`);
  if (rawResp === null) throw new Error('The raw link gave no response');
  expect((await rawResp.body()).equals(Buffer.from(site['index.html'] as string))).toBe(true);
  const rawBase = page.url().replace(/[^/]*$/, '');
  await nestedFramesLoaded(page.mainFrame());
  for (const frame of [page.mainFrame(), ...descendants(page.mainFrame())]) {
    expect(await hasAnnotator(frame)).toBe(false);
  }
  const raw = await observe(page.mainFrame(), rawBase);
  expect(await hasAnnotator(page.mainFrame())).toBe(false);

  // The review screen frames the same version through a review grant.
  await page.goto(`/a/${pub.artifact_id}`);
  await expect(page.locator('[data-annotator="ready"]')).toBeVisible();
  const el = page.locator('iframe[sandbox]');
  expect(await el.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
  expect(await el.getAttribute('srcdoc')).toBeNull();
  const reviewRoot = await (await el.elementHandle())?.contentFrame();
  const reviewBase = await el.getAttribute('src');
  if (!reviewRoot || reviewBase === null) throw new Error('The review frame is not there');
  await nestedFramesLoaded(reviewRoot);
  const reviewFrames = [reviewRoot, ...descendants(reviewRoot)];
  expect(reviewFrames).toHaveLength(3);
  for (const frame of reviewFrames) expect(await hasAnnotator(frame)).toBe(true);
  const review = await observe(reviewRoot, reviewBase);

  expect(review).toEqual(raw);
  expect(raw.title).toBe('Fidelity');
  expect(raw.marker).toBe('entry');
  expect(raw.frames).toEqual([
    { path: 'frames/inner.html', text: 'Inner frame' },
    { path: 'frames/deeper.html', text: 'Deeper frame' },
  ]);
  expect(raw.video).toEqual({ ready: true, videoWidth: 64 });
  expect(raw.anchor).toEqual({ hash: '#section-3', top: true, sameDocument: true });
  expect(raw.link).toEqual({ path: 'about.html', h1: 'About' });
  // Range-served in both runs: different grant URLs, so no cache hit.
  expect(ranges.filter((s) => s === 206).length).toBeGreaterThanOrEqual(2);
  // The app's frame-src admits the content in both modes.
  expect(csp).toEqual([]);
});
