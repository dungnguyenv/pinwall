import { ContentGrant } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { renderContentErrorPage } from '../../src/content/error-page.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { apiInit } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import {
  addMember,
  MODES,
  type Person,
  removeMember,
  type SpacesFixture,
  sameAnswer,
  spacesContext,
  spacesFixture,
  UNKNOWN_IDS,
} from './fixture.ts';

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** The grant token in a single-domain content URL, `…/c/<token>/`. */
function tokenIn(url: string): string {
  const token = /\/c\/([0-9a-hjkmnp-tv-z]{32})\/$/.exec(url)?.[1];
  if (token === undefined) throw new Error(`Not a content URL: ${url}`);
  return token;
}

/** A response as `sameAnswer` compares it: the status, and the body parsed when it is JSON. */
async function answerOf(res: Response): Promise<{ status: number; body: unknown }> {
  const json = res.headers.get('content-type')?.includes('application/json') ?? false;
  return { status: res.status, body: json ? await res.json() : await res.text() };
}

describe.each(dialects)('content and links on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
    });
    // Tests take people out of P, so each gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    /** The content at `index.html` of grant `token`: its status and page. */
    async function served(token: string): Promise<{ status: number; body: string }> {
      const res = await fetchContent(ctx, token, 'index.html');
      return { status: res.status, body: await res.text() };
    }

    /** `person`'s review grant on version 2 of `artifactId`, and their raw one on its current. */
    async function grantsOf(person: Person, artifactId: string): Promise<string[]> {
      const preview = await ctx.request(
        `/api/v1/artifacts/${artifactId}/versions/2/preview?mode=review`,
        apiInit(ctx, { cookie: person.cookie }),
      );
      expect(preview.status, await preview.clone().text()).toBe(200);
      const review = tokenIn(ContentGrant.parse(await preview.json()).url);
      const raw = await ctx.request(`/a/${artifactId}/raw`, {
        headers: { cookie: person.cookie },
        redirect: 'manual',
      });
      expect(raw.status, await raw.clone().text()).toBe(302);
      return [review, tokenIn(raw.headers.get('location') ?? '')];
    }

    test('a member grant stops serving once its holder cannot see the artifact', async () => {
      const { A, E } = fx.people;
      const { P, p } = fx.ids;
      const tokens = await grantsOf(E, p);
      for (const token of tokens) expect((await served(token)).status).toBe(200);

      await removeMember(ctx, P, E.user.id);
      for (const token of tokens) {
        const answer = await served(token);
        if (mode === 'team') expect(answer.status).toBe(200);
        // Like a deleted version: the content's own "gone" page.
        else expect(answer).toEqual({ status: 410, body: renderContentErrorPage('gone') });
      }

      // The grants were refused, not deleted: they serve again once E sees p again.
      await addMember(ctx, P, E.user.id, 'editor', A.user.id);
      for (const token of tokens) expect((await served(token)).status).toBe(200);
    });

    test('raw links answer an invisible artifact like a missing one, in the browser and to an agent', async () => {
      const { S } = fx.people;
      const browser = (artifactId: string) =>
        ctx.request(`/a/${artifactId}/raw`, {
          headers: { cookie: S.cookie, accept: BROWSER },
          redirect: 'manual',
        });
      const agent = (artifactId: string) =>
        ctx.request(`/a/${artifactId}/v/1/raw`, {
          headers: { authorization: `Bearer ${S.token}` },
          redirect: 'manual',
        });

      for (const [client, type] of [
        [browser, 'text/html; charset=UTF-8'],
        [agent, 'application/json'],
      ] as const) {
        const res = await client(fx.ids.q);
        if (mode === 'team') {
          expect(res.status, await res.clone().text()).toBe(302);
          continue;
        }
        const missing = await client(UNKNOWN_IDS.q);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe(type);
        expect(res.headers.get('content-type')).toBe(missing.headers.get('content-type'));
        sameAnswer(await answerOf(res), await answerOf(missing));
      }
    });

    test('a share link stops opening when its maker can no longer see the artifact', async () => {
      const { A, E } = fx.people;
      const { P, p } = fx.ids;
      const options = { versionId: null, password: null, expiresAt: null, allowComments: false };
      const { token } = await createShareLink(ctx.deps, E.user, p, options);
      // A link E revoked: what a link whose maker lost sight must answer like.
      const revoked = await createShareLink(ctx.deps, E.user, p, options);
      await revokeShareLink(ctx.deps, E.user, revoked.row.id);

      const page = async (of: string) => answerOf(await ctx.request(`/s/${of}`));
      const info = async (of: string) =>
        answerOf(await ctx.request(`/api/v1/share/${of}`, apiInit(ctx)));

      /** The link redirects to its bytes, which serve, and its viewer's info answers. */
      async function expectOpens(): Promise<void> {
        const opened = await ctx.request(`/s/${token}`, { redirect: 'manual' });
        expect(opened.status, await opened.clone().text()).toBe(302);
        const bytes = await ctx.request(opened.headers.get('location') ?? '');
        expect(bytes.status).toBe(200);
        const shown = await info(token);
        expect(shown.status, JSON.stringify(shown.body)).toBe(200);
      }

      await expectOpens();
      await removeMember(ctx, P, E.user.id);
      if (mode === 'team') {
        await expectOpens();
        return;
      }
      const refused = await info(token);
      expect(refused).toMatchObject({
        status: 410,
        body: { error: { details: { reason: 'revoked' } } },
      });
      sameAnswer(refused, await info(revoked.token));
      const refusedPage = await page(token);
      expect(refusedPage.status).toBe(410);
      sameAnswer(refusedPage, await page(revoked.token));

      // Suspended, not revoked: it opens again once E sees p again.
      await addMember(ctx, P, E.user.id, 'editor', A.user.id);
      await expectOpens();
    });
  });
});
