import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import {
  type Container,
  removeContainers,
  runImage,
  waitForSetupUrl,
  waitUntilReady,
} from '../support/docker.ts';
import { type Api, OWNER_NAME, publishSite, signIn } from '../support/node-api.ts';

/*
 * Acceptance 1, 7, 9 and 10 against the built image, started as the README says on a fresh
 * volume. The walks share the install the first one sets up, so they run in order.
 */

const image = process.env.PINWALL_ACCEPTANCE_IMAGE || 'pinwall:acceptance';
const port = Number(process.env.PINWALL_ACCEPTANCE_PORT || 8080);
const id = randomBytes(4).toString('hex');
const volume = `pinwall-acc-${id}`;
const PASSWORD = 'correct horse battery staple';
const FIVE_MINUTES_MS = 300_000;

/** Every container this file started, removed by name at the end with the volume. */
const started: string[] = [];
let install: Container;

async function start(name: string, env?: Record<string, string>): Promise<Container> {
  started.push(name);
  return runImage({ image, name, volume, port, env });
}

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Where the local blob store keeps a file with this SHA-256. */
const blobPath = (sha: string) => `/data/blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await removeContainers(started, [volume]);
});

test('1: docker run and the setup link give a working install in under five minutes', async ({
  page,
}, info) => {
  test.setTimeout(FIVE_MINUTES_MS + 60_000);
  const begun = Date.now();
  install = await start(`pinwall-acc-${id}`);
  const setupUrl = await waitForSetupUrl(install, 120_000);
  expect(setupUrl).toMatch(new RegExp(`^http://localhost:${port}/setup\\?token=`));

  // The owner account, with a password (the browser here has no passkey to offer).
  await page.goto(setupUrl);
  await expect(page.getByRole('heading', { name: 'Set up Pinwall' })).toBeVisible();
  await page.getByLabel('Your name').fill(OWNER_NAME);
  const passkey = page.getByRole('switch', { name: 'Passkey' });
  if (await passkey.isVisible()) {
    await passkey.uncheck();
    await page.getByRole('switch', { name: 'Password' }).check();
  }
  await page.getByLabel('Choose a password').fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();

  // A first page, uploaded from the library, then opened in review.
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Upload to / });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: 'Choose files or an archive' }).click(),
  ]);
  await chooser.setFiles({
    name: 'index.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<h1>Hello acceptance</h1>'),
  });
  await expect(page.getByText(/^Published “.+” v1$/)).toBeVisible();
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page).toHaveURL(/\/a\/[^/]+$/);
  await expect(
    page.frameLocator('iframe[sandbox]').getByRole('heading', { name: 'Hello acceptance' }),
  ).toBeVisible();

  const elapsed = Date.now() - begun;
  info.annotations.push({
    type: 'elapsed',
    description: `${Math.round(elapsed / 1000)} s (image already pulled)`,
  });
  expect(elapsed).toBeLessThan(FIVE_MINUTES_MS);
});

test('7: "chup anh" finds the artifact containing "chụp ảnh"', async () => {
  const api = await signIn(install.origin, PASSWORD);
  const published = await publishSite(api, {
    'index.html': '<!doctype html><meta charset="utf-8"><h1>Dịch vụ chụp ảnh</h1>',
  });
  const found = await api.call<{ items: { id: string }[] }>(
    'GET',
    '/api/v1/artifacts?q=chup%20anh',
  );
  expect(found.status).toBe(200);
  expect(found.json.items.map((item) => item.id)).toContain(published.artifact_id);
});

test('9: deleting a version with a secret makes its links gone and removes its files', async () => {
  const api = await signIn(install.origin, PASSWORD);
  const secret = `sk-live-${randomBytes(16).toString('hex')}`;
  const shared = `body { color: #${randomBytes(3).toString('hex')}; }\n`;
  const v1 = await publishSite(api, {
    'index.html': '<!doctype html><link rel="stylesheet" href="shared.css"><h1>Keys v1</h1>',
    'secret.txt': secret,
    'shared.css': shared,
  });
  const v2 = await publishSite(
    api,
    {
      'index.html': '<!doctype html><link rel="stylesheet" href="shared.css"><h1>Keys v2</h1>',
      'shared.css': shared,
    },
    { artifact_id: v1.artifact_id, expected_version_id: v1.version_id },
  );
  expect(v2.version_number).toBe(2);
  const link = `/a/${v1.artifact_id}/v/1/raw`;
  const exists = async (sha: string) =>
    (await install.exec(['sh', '-c', `test -e ${blobPath(sha)}`])).code === 0;

  // Before: the raw link leads to a grant that serves the secret, which is in storage.
  const raw = await api.call('GET', link);
  expect(raw.status).toBe(302);
  const grant = new URL(raw.headers.get('location') ?? '', install.origin).href;
  const before = await fetch(new URL('secret.txt', grant));
  expect(before.status).toBe(200);
  expect(await before.text()).toBe(secret);
  expect(await exists(sha256(secret))).toBe(true);

  // Deleting version 1: the link and the grant answer "gone" at once.
  expect((await api.call('DELETE', `/api/v1/artifacts/${v1.artifact_id}/versions/1`)).status).toBe(
    204,
  );
  expect((await api.call('GET', link)).status).toBe(410);
  expect((await fetch(new URL('secret.txt', grant))).status).toBe(410);

  // The secret's file is gone from storage; the stylesheet, still in version 2, is not.
  const secretGone = await install.exec(['sh', '-c', `test ! -e ${blobPath(sha256(secret))}`]);
  expect(secretGone.code).toBe(0);
  const sharedKept = await install.exec(['sh', '-c', `test -e ${blobPath(sha256(shared))}`]);
  expect(sharedKept.code).toBe(0);
});

/** Signs the owner in through the sign-in page. */
async function signInInBrowser(page: Page, origin: string): Promise<void> {
  await page.goto(new URL('/signin', origin).href);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();
}

/** The bytes Node gets from a link that redirects to a grant (single-domain mode only). */
async function bytesThrough(api: Api, link: string): Promise<{ url: URL; bytes: Buffer }> {
  const first = await api.call('GET', link, undefined, { accept: '*/*' });
  expect(first.status, link).toBe(302);
  const url = new URL(first.headers.get('location') ?? '', api.origin);
  const response = await fetch(url);
  expect(response.status, link).toBe(200);
  return { url, bytes: Buffer.from(await response.arrayBuffer()) };
}

test('10: switching the isolation mode and restarting keeps every link working', async ({
  page,
}) => {
  const api = await signIn(install.origin, PASSWORD);
  const pages = {
    v1: '<!doctype html><title>Isolation</title><h1>Isolation v1</h1>\n',
    v2: '<!doctype html><title>Isolation</title><h1>Isolation v2</h1>\n',
  };
  const v1 = await publishSite(api, { 'index.html': pages.v1 });
  await publishSite(
    api,
    { 'index.html': pages.v2 },
    { artifact_id: v1.artifact_id, expected_version_id: v1.version_id },
  );
  const artifact = v1.artifact_id;
  const share = await api.call<{ token: string }>(
    'POST',
    `/api/v1/artifacts/${artifact}/share-links`,
    {},
  );
  expect(share.status).toBe(201);
  /** Each link people hold, with the bytes it must deliver. */
  const links: [string, string][] = [
    [`/a/${artifact}/raw`, pages.v2],
    [`/a/${artifact}/v/1/raw`, pages.v1],
    [`/a/${artifact}/v/2/raw`, pages.v2],
    [`/s/${share.json.token}`, pages.v2],
  ];
  for (const [link, bytes] of links) {
    const seen = await bytesThrough(api, link);
    expect(seen.url.pathname, link).toMatch(/^\/c\//);
    expect(seen.bytes.equals(Buffer.from(bytes)), link).toBe(true);
  }

  /** Opens every link in the browser and checks where it lands and what it delivers. */
  const checkLinks = async (landsOn: (url: URL) => boolean) => {
    for (const [link, bytes] of links) {
      const response = await page.goto(new URL(link, install.origin).href);
      expect(response?.status(), link).toBe(200);
      const landed = new URL(page.url());
      expect(landsOn(landed), `${link} landed on ${landed.origin}${landed.pathname}`).toBe(true);
      expect((await response?.body())?.equals(Buffer.from(bytes)), link).toBe(true);
    }
  };
  const reviewFrame = page.locator('iframe[sandbox]');

  // Content-domain mode on the same volume: each link lands on a content host of its own.
  const contentHost = `pwc.localhost:${port}`;
  await install.stop();
  install = await start(`pinwall-acc-${id}-content`, {
    PINWALL_ISOLATION: 'content-domain',
    PINWALL_CONTENT_ORIGIN: `http://${contentHost}`,
  });
  await waitUntilReady(install, 120_000);
  await signInInBrowser(page, install.origin);
  await checkLinks((url) => url.host.endsWith(`.${contentHost}`));
  await page.goto(new URL(`/a/${artifact}`, install.origin).href);
  await expect(reviewFrame).toHaveAttribute(
    'src',
    new RegExp(`^http://[^/]+\\.${contentHost.replace(/\./g, '\\.')}/`),
  );
  await expect(
    page.frameLocator('iframe[sandbox]').getByRole('heading', { name: 'Isolation v2' }),
  ).toBeVisible();

  // Back to single-domain mode: the same links land under /c/ on the app origin.
  await install.stop();
  install = await start(`pinwall-acc-${id}-single`);
  await waitUntilReady(install, 120_000);
  const appHost = new URL(install.origin).host;
  await checkLinks((url) => url.host === appHost && url.pathname.startsWith('/c/'));
  await page.goto(new URL(`/a/${artifact}`, install.origin).href);
  await expect(reviewFrame).toHaveAttribute('src', /\/c\//);
  await expect(
    page.frameLocator('iframe[sandbox]').getByRole('heading', { name: 'Isolation v2' }),
  ).toBeVisible();
});
