import { ContentGrant } from '@pinwall/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type ContentErrorKind, renderContentErrorPage } from '../../src/content/error-page.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { gone } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { abuseHref } from '../../src/pages/error-page.tsx';
import { apiInit } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { type SpacesFixture, spacesFixture } from '../spaces/fixture.ts';
import { contextWith, moderationContext } from './helpers.ts';

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const EMAIL = 'abuse@example.org';
const URL_CONTACT = 'https://example.org/report';

/** Whether `page` has the abuse line, and where it points. */
const reportsAbuse = (page: string) => page.includes(t('pages.reportAbuse'));

test('abuseHref links an email address with mailto: and anything else as it is', () => {
  expect(abuseHref(EMAIL)).toBe(`mailto:${EMAIL}`);
  expect(abuseHref(URL_CONTACT)).toBe(URL_CONTACT);
  expect(abuseHref('http://example.org/r?a=1')).toBe('http://example.org/r?a=1');
});

test('only the content pages that say a link is missing or ended carry the abuse line', () => {
  const kinds: [ContentErrorKind, boolean][] = [
    ['not_found', true],
    ['gone', true],
    ['expired', true],
    ['error', false],
    ['framed_only', false],
  ];
  for (const [kind, shown] of kinds) {
    const page = renderContentErrorPage(kind, EMAIL);
    expect(reportsAbuse(page), kind).toBe(shown);
    expect(page.includes(`href="mailto:${EMAIL}"`), kind).toBe(shown);
    // Without a contact the page is the 1.0 page, byte for byte.
    expect(renderContentErrorPage(kind, null), kind).toBe(renderContentErrorPage(kind));
    expect(reportsAbuse(renderContentErrorPage(kind)), kind).toBe(false);
  }
  // Anything an operator writes is escaped like the rest of the page.
  const quoted = renderContentErrorPage('gone', 'https://example.org/r?a=1&b="2"');
  expect(quoted).toContain('href="https://example.org/r?a=1&#38;b=&#34;2&#34;"');
});

describe.each(dialects)('the abuse contact on %s', (dialect) => {
  let base: TestContext;
  let withEmail: TestContext;
  let withUrl: TestContext;
  let fx: SpacesFixture;
  beforeAll(async () => {
    base = await moderationContext(dialect, 'personal', { PINWALL_ABUSE_CONTACT: EMAIL });
    withEmail = base;
    withUrl = contextWith(base, { abuseContact: URL_CONTACT });
    fx = await spacesFixture(base);
  });
  afterAll(() => base?.close());

  const withoutContact = () => contextWith(base, { abuseContact: null });
  const html = { headers: { accept: BROWSER } };

  /** A share link of A's on artifact p, and its token. */
  async function shareOfP() {
    const { A } = fx.people;
    return createShareLink(base.deps, A.user, fx.ids.p, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: false,
    });
  }

  test('gone and not-found pages show the abuse contact when it is set', async () => {
    // An app page: the 404 for any path.
    const missing = await withEmail.request('/nowhere', html);
    expect(missing.status).toBe(404);
    const missingPage = await missing.text();
    expect(missingPage).toContain(`href="mailto:${EMAIL}"`);
    expect(missingPage).toContain(
      `${t('pages.reportAbuse')} <a href="mailto:${EMAIL}">${EMAIL}</a>`,
    );

    // An app page for a 410, on an app of its own: routes cannot be added once one has served.
    const fresh = contextWith(base, {});
    fresh.app.get('/vanished', () => {
      throw gone('It was deleted.');
    });
    const vanished = await fresh.request('/vanished', html);
    expect(vanished.status).toBe(410);
    expect(await vanished.text()).toContain(`href="mailto:${EMAIL}"`);

    // The share viewer: a revoked link, and a link that never existed.
    const { row, token } = await shareOfP();
    await revokeShareLink(base.deps, fx.people.A.user, row.id);
    const revoked = await withEmail.request(`/s/${token}`, html);
    expect(revoked.status).toBe(410);
    expect(await revoked.text()).toContain(`href="mailto:${EMAIL}"`);
    const unknown = await withEmail.request(`/s/${'x'.repeat(43)}`, html);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain(`href="mailto:${EMAIL}"`);

    // Content: a token that was never issued, and one that ended.
    const never = await fetchContent(withEmail, 'a'.repeat(32), '');
    expect(never.status).toBe(404);
    expect(await never.text()).toContain(`href="mailto:${EMAIL}"`);
    const ended = 'b'.repeat(32);
    await addTombstones(
      base.deps.db.db,
      [{ kind: 'content_grant', key: ended, expiresAt: null }],
      base.deps.clock.now(),
    );
    const endedPage = await fetchContent(withEmail, ended, '');
    expect(endedPage.status).toBe(410);
    expect(await endedPage.text()).toContain(`href="mailto:${EMAIL}"`);
  });

  test('a URL contact links to the URL itself', async () => {
    const pages = [
      await withUrl.request('/nowhere', html),
      await withUrl.request(`/s/${'x'.repeat(43)}`, html),
      await fetchContent(withUrl, 'a'.repeat(32), ''),
    ];
    for (const res of pages) {
      expect(res.status).toBe(404);
      const page = await res.text();
      expect(page).toContain(`<a href="${URL_CONTACT}">${URL_CONTACT}</a>`);
      expect(page).not.toContain('mailto:');
    }
  });

  test('without the setting no page has the abuse line', async () => {
    const ctx = withoutContact();
    const { row, token } = await shareOfP();
    await revokeShareLink(base.deps, fx.people.A.user, row.id);
    const pages = [
      await ctx.request('/nowhere', html),
      await ctx.request(`/s/${token}`, html),
      await ctx.request(`/s/${'x'.repeat(43)}`, html),
      await fetchContent(ctx, 'a'.repeat(32), ''),
    ];
    for (const res of pages) {
      expect([404, 410]).toContain(res.status);
      const page = await res.text();
      expect(reportsAbuse(page)).toBe(false);
      expect(page).not.toContain('mailto:');
    }
  });

  test('other error pages never show it', async () => {
    // A 403 page: a raw link a member who is not approved may not follow.
    const ap = contextWith(base, { shareLinks: 'approved' });
    const { E } = fx.people;
    const refused = await ap.request(`/a/${fx.ids.p}/raw`, {
      headers: { cookie: E.cookie, accept: BROWSER },
      redirect: 'manual',
    });
    expect(refused.status).toBe(403);
    const refusedPage = await refused.text();
    expect(refusedPage).toContain(t('spaces.exposure.rawLink'));
    expect(reportsAbuse(refusedPage)).toBe(false);

    // A 429 on a share link: the limit counts every open, and the page speaks of the limit only.
    const limited = contextWith(base, {});
    let last = await limited.request(`/s/${'x'.repeat(43)}`, html);
    for (let i = 0; i < 120 && last.status !== 429; i++) {
      last = await limited.request(`/s/${'x'.repeat(43)}`, html);
    }
    expect(last.status).toBe(429);
    expect(reportsAbuse(await last.text())).toBe(false);
    (base.deps.clock as FixedClock).advance(600_000);

    // The page a framed-only grant gives to a page of its own.
    const preview = await ap.request(
      `/api/v1/artifacts/${fx.ids.p}/versions/2/preview?mode=review`,
      apiInit(ap, { cookie: E.cookie }),
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    const url = ContentGrant.parse(await preview.json()).url;
    const grant = /\/c\/([0-9a-hjkmnp-tv-z]{32})\//.exec(url)?.[1];
    if (grant === undefined) throw new Error(`Not a content URL: ${url}`);
    const framed = await fetchContent(ap, grant, '');
    expect(framed.status).toBe(403);
    const framedPage = await framed.text();
    expect(framedPage).toContain(t('content.framedOnly.title'));
    expect(reportsAbuse(framedPage)).toBe(false);
  });
});
