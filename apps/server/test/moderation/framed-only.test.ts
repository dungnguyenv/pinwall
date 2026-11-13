import { ContentGrant, ShareInfo } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { CONTENT_SANDBOX_CSP } from '../../src/content/serve.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type Person, type SpacesFixture, spacesFixture } from '../spaces/fixture.ts';
import { approve, contextWith, moderationContext } from './helpers.ts';

const ISOLATIONS = ['single-domain', 'content-domain'] as const;

const ENV: Record<(typeof ISOLATIONS)[number], Record<string, string>> = {
  'single-domain': { PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' },
  'content-domain': {
    PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test',
    PINWALL_ISOLATION: 'content-domain',
    PINWALL_CONTENT_ORIGIN: 'https://pw-content.test:8443',
  },
};

const FRAME_ANCESTORS = "frame-ancestors 'self' https://pinwall.test";

/** A request as a browser makes it for `destination` (`Sec-Fetch-Dest`), or without fetch metadata. */
const dest = (destination?: string): RequestInit => ({
  headers: destination === undefined ? {} : { 'sec-fetch-dest': destination },
});

/** The grant token in a content URL of either isolation mode. */
function tokenIn(url: string): string {
  const token =
    /^https:\/\/pinwall\.test\/c\/([0-9a-hjkmnp-tv-z]{32})\/$/.exec(url)?.[1] ??
    /^https:\/\/([0-9a-hjkmnp-tv-z]{32})\.pw-content\.test:8443\/$/.exec(url)?.[1];
  if (token === undefined) throw new Error(`Not a content URL: ${url}`);
  return token;
}

describe.each(dialects)('framed-only content on %s', (dialect) => {
  describe.each(ISOLATIONS)('in %s mode', (isolation) => {
    let ctx: TestContext;
    let ap: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, 'personal', ENV[isolation]);
      ap = contextWith(ctx, { shareLinks: 'approved' });
    });
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    /** The policy of a framed-only grant's responses, and of every other grant's. */
    const framedCsp =
      isolation === 'single-domain'
        ? `${CONTENT_SANDBOX_CSP}; ${FRAME_ANCESTORS}`
        : FRAME_ANCESTORS;
    const plainCsp = isolation === 'single-domain' ? CONTENT_SANDBOX_CSP : null;

    /** `person`'s grant from the preview API on version `n` of `artifactId`, asked through `ap`. */
    async function previewGrant(
      person: Person,
      artifactId: string,
      o: { mode?: 'review' | 'raw'; n?: number } = {},
    ): Promise<string> {
      const r = await ap.request(
        `/api/v1/artifacts/${artifactId}/versions/${o.n ?? 2}/preview?mode=${o.mode ?? 'review'}`,
        apiInit(ap, { cookie: person.cookie }),
      );
      expect(r.status, await r.clone().text()).toBe(200);
      return tokenIn(ContentGrant.parse(await r.json()).url);
    }

    const get = (token: string, path: string, destination?: string) =>
      fetchContent(ap, token, path, dest(destination));

    test('a grant of a person who is not approved serves only inside a frame', async () => {
      const token = await previewGrant(fx.people.E, fx.ids.p);

      // A top-level load, or one without fetch metadata, before any file is looked up.
      for (const [path, destination] of [
        ['', 'document'],
        ['', undefined],
        ['missing.html', 'document'],
      ] as const) {
        const refused = await get(token, path, destination);
        expect(refused.status, `${path} as ${destination}`).toBe(403);
        expect(refused.headers.get('content-security-policy')).toBe(framedCsp);
        expect(await refused.text()).toContain(t('content.framedOnly.title'));
      }

      // Inside Pinwall's viewer, and the page's own loads.
      for (const [path, destination] of [
        ['', 'iframe'],
        ['cover.png', 'image'],
        ['__pinwall/annotator.js', 'script'],
        ['notes.md', 'empty'],
      ] as const) {
        const served = await get(token, path, destination);
        expect(served.status, `${path} as ${destination}`).toBe(200);
        expect(served.headers.get('content-security-policy')).toContain(FRAME_ANCESTORS);
        expect(served.headers.get('content-security-policy')).toBe(framedCsp);
      }

      const missing = await get(token, 'missing.html', 'iframe');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-security-policy')).toBe(framedCsp);

      if (isolation === 'single-domain') {
        // `/c/<token>` without its slash redirects a frame, and refuses a top-level load.
        const root = (destination: string) => ap.request(`/c/${token}`, dest(destination));
        const redirected = await root('iframe');
        expect(redirected.status).toBe(308);
        expect(redirected.headers.get('content-security-policy')).toBe(framedCsp);
        expect((await root('document')).status).toBe(403);
      }
    });

    test('a raw grant from the preview API is framed-only too', async () => {
      const token = await previewGrant(fx.people.E, fx.ids.p, { mode: 'raw' });
      expect((await get(token, '', 'document')).status).toBe(403);
      const served = await get(token, '', 'iframe');
      expect(served.status).toBe(200);
      expect(served.headers.get('content-security-policy')).toBe(framedCsp);
    });

    test('approval takes effect on the next content request', async () => {
      const { E } = fx.people;
      const token = await previewGrant(E, fx.ids.p);
      expect((await get(token, '', 'document')).status).toBe(403);

      await approve(ctx, E.user.id);
      const served = await get(token, '', 'document');
      expect(served.status).toBe(200);
      expect(served.headers.get('content-security-policy')).toBe(plainCsp);

      await approve(ctx, E.user.id, false);
      const refused = await get(token, '', 'document');
      expect(refused.status).toBe(403);
      expect(refused.headers.get('content-security-policy')).toBe(framedCsp);
    });

    test("an approved person's grants and share-link grants carry no frame-ancestors", async () => {
      const { X } = fx.people;
      const { artifact } = await publishFiles(ctx, X.user, { 'index.html': '<p>X</p>' });

      const own = await get(await previewGrant(X, artifact.id, { n: 1 }), '', 'document');
      expect(own.status).toBe(200);
      expect(own.headers.get('content-security-policy')).toBe(plainCsp);

      const { token } = await createShareLink(ctx.deps, X.user, artifact.id, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: true,
      });
      const info = await ap.request(`/api/v1/share/${token}`, apiInit(ap));
      expect(info.status).toBe(200);
      const { content } = ShareInfo.parse(await info.json());
      const shared = await get(tokenIn(content.url), '', 'document');
      expect(shared.status).toBe(200);
      expect(shared.headers.get('content-security-policy')).toBe(plainCsp);
    });
  });
});
