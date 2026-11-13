import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { mayExpose } from '../../src/domain/exposure.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import {
  MODES,
  type Person,
  type SpacesFixture,
  sameAnswer,
  spacesFixture,
  UNKNOWN_IDS,
} from '../spaces/fixture.ts';
import { approve, contextWith, moderationContext } from './helpers.ts';

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** The refusal of the policy, as REST answers it. */
const notApprovedBody = (what: 'shareLink' | 'rawLink') => ({
  error: {
    code: 'forbidden',
    message: t(`spaces.exposure.${what}`),
    details: { reason: 'share_links_not_approved' },
  },
});

/** A response as `sameAnswer` compares it: the status, and the body parsed when it is JSON. */
async function answerOf(res: Response): Promise<{ status: number; body: unknown }> {
  const json = res.headers.get('content-type')?.includes('application/json') ?? false;
  return { status: res.status, body: json ? await res.json() : await res.text() };
}

test('the loader reads PINWALL_SHARE_LINKS', () => {
  expect(loadConfig({}).shareLinks).toBe('members');
  expect(loadConfig({ PINWALL_SHARE_LINKS: 'approved' }).shareLinks).toBe('approved');
  expect(() => loadConfig({ PINWALL_SHARE_LINKS: 'admins' })).toThrow(
    /PINWALL_SHARE_LINKS: must be "members" or "approved"/,
  );
});

describe.each(dialects)('exposing content on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    // `ctx` lets every member share, so the fixture can make its links; `ap` is the same
    // instance with PINWALL_SHARE_LINKS=approved.
    let ctx: TestContext;
    let ap: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, mode);
      ap = contextWith(ctx, { shareLinks: 'approved' });
    });
    // Tests approve people, so each gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    /** `person`'s row as it is stored now. */
    const rowOf = (person: Person) =>
      ctx.deps.db.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', person.user.id)
        .executeTakeFirstOrThrow();

    /** A new artifact `person` publishes to their default project: one they see in either mode. */
    async function ownArtifact(person: Person): Promise<string> {
      const { artifact } = await publishFiles(ctx, person.user, { 'index.html': '<p>Own</p>' });
      return artifact.id;
    }

    /** A link `maker` makes while everyone may share: no password, comments off. */
    function linkBy(maker: Person, artifactId: string) {
      return createShareLink(ctx.deps, maker.user, artifactId, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: false,
      });
    }

    test('mayExpose lets everyone with members, and admins and approved members with approved', async () => {
      const { E, X } = fx.people;
      expect(mayExpose(ctx.deps.config, E.user)).toBe(true);
      expect(mayExpose(ap.deps.config, E.user)).toBe(false);
      expect(mayExpose(ap.deps.config, X.user)).toBe(true);
      expect(mayExpose(ap.deps.config, { ...E.user, kind: 'owner', idp_role: null })).toBe(true);
      await approve(ctx, E.user.id);
      expect(mayExpose(ap.deps.config, await rowOf(E))).toBe(true);
    });

    test('a member who is not approved cannot create a share link, on REST or MCP', async () => {
      const { E, X } = fx.people;
      const create = (c: TestContext, who: Person, artifactId: string) =>
        restClient(c, who.cookie).post(`/artifacts/${artifactId}/share-links`, {});

      const refused = await create(ap, E, fx.ids.e);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(notApprovedBody('shareLink'));
      // The check comes before the lookup: an unknown artifact gets the same answer.
      sameAnswer(refused, await create(ap, E, UNKNOWN_IDS.e));

      const agent = await connectMcp(ap, { bearer: E.token });
      try {
        const r = (await agent.callTool({
          name: 'create_share_link',
          arguments: { artifact_id: fx.ids.e },
        })) as CallToolResult;
        expect(r.isError).toBe(true);
        expect(toolText(r)).toContain(t('spaces.exposure.shareLink'));
      } finally {
        await agent.close();
      }

      expect((await create(ap, X, await ownArtifact(X))).status).toBe(201);
      expect((await create(ctx, E, fx.ids.e)).status).toBe(201);
      await approve(ctx, E.user.id);
      expect((await create(ap, E, fx.ids.e)).status).toBe(201);
    });

    test('links a person made before still list and can be revoked', async () => {
      const { E } = fx.people;
      const api = restClient(ap, E.cookie);
      const listed = await api.get<{ items: { id: string }[] }>(
        `/artifacts/${fx.ids.e}/share-links`,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((link) => link.id)).toEqual([fx.ids.eLink]);
      expect((await api.del(`/share-links/${fx.ids.eLink}`)).status).toBe(204);
    });

    test('a link stops opening once its maker is not approved, and opens again after approval', async () => {
      const { A, E, X } = fx.people;
      const eLink = await linkBy(E, fx.ids.e);
      const aLink = await linkBy(A, fx.ids.p);
      const xLink = await linkBy(X, await ownArtifact(X));
      // A link E revoked: what a link whose maker is not approved must answer like.
      const revoked = await linkBy(E, fx.ids.e);
      await revokeShareLink(ctx.deps, E.user, revoked.row.id);

      const page = async (c: TestContext, token: string) =>
        answerOf(await c.request(`/s/${token}`, { redirect: 'manual' }));
      const original = async (c: TestContext, token: string) =>
        answerOf(await c.request(`/s/${token}/original`, { redirect: 'manual' }));
      const info = async (c: TestContext, token: string) =>
        answerOf(await c.request(`/api/v1/share/${token}`, apiInit(c)));
      /** How the link's page, its original and the share viewer's info answer through `c`. */
      const statuses = async (c: TestContext, token: string) => [
        (await page(c, token)).status,
        (await original(c, token)).status,
        (await info(c, token)).status,
      ];
      const OPEN = [302, 302, 200];

      for (const link of [eLink, aLink, xLink]) {
        expect(await statuses(ctx, link.token)).toEqual(OPEN);
      }

      for (const link of [eLink, aLink]) {
        const refusedPage = await page(ap, link.token);
        expect(refusedPage.status).toBe(410);
        expect(refusedPage.body).toContain(t('share.gone.title'));
        sameAnswer(refusedPage, await page(ap, revoked.token));
        sameAnswer(await original(ap, link.token), await original(ap, revoked.token));
        const refusedInfo = await info(ap, link.token);
        expect(refusedInfo).toEqual({
          status: 410,
          body: {
            error: {
              code: 'gone',
              message: t('share.gone.message'),
              details: { reason: 'revoked' },
            },
          },
        });
        sameAnswer(refusedInfo, await info(ap, revoked.token));
      }
      expect(await statuses(ap, xLink.token)).toEqual(OPEN);

      // Suspended, not revoked: it opens again once E is approved.
      await approve(ctx, E.user.id);
      expect(await statuses(ap, eLink.token)).toEqual(OPEN);
      const row = await ctx.deps.db.db
        .selectFrom('share_links')
        .select('revoked_at')
        .where('id', '=', eLink.row.id)
        .executeTakeFirstOrThrow();
      expect(row.revoked_at).toBeNull();
    });

    test('raw links explain the restriction to a person who is not approved', async () => {
      const { E, X } = fx.people;
      const browser = (c: TestContext, who: Person, artifactId: string) =>
        c.request(`/a/${artifactId}/raw`, {
          headers: { cookie: who.cookie, accept: BROWSER },
          redirect: 'manual',
        });
      const agent = (c: TestContext, who: Person, artifactId: string) =>
        c.request(`/a/${artifactId}/v/1/raw`, {
          headers: { authorization: `Bearer ${who.token}` },
          redirect: 'manual',
        });

      const refusedPage = await browser(ap, E, fx.ids.p);
      expect(refusedPage.headers.get('content-type')).toBe('text/html; charset=UTF-8');
      const shown = await answerOf(refusedPage);
      expect(shown.status).toBe(403);
      expect(shown.body).toContain(t('spaces.exposure.rawLink'));
      // The check comes before the lookup: an unknown artifact gets the same page.
      sameAnswer(shown, await answerOf(await browser(ap, E, UNKNOWN_IDS.p)));

      expect(await answerOf(await agent(ap, E, fx.ids.p))).toEqual({
        status: 403,
        body: notApprovedBody('rawLink'),
      });

      expect((await browser(ctx, E, fx.ids.p)).status).toBe(302);
      expect((await agent(ctx, E, fx.ids.p)).status).toBe(302);
      expect((await browser(ap, X, await ownArtifact(X))).status).toBe(302);
      await approve(ctx, E.user.id);
      expect((await browser(ap, E, fx.ids.p)).status).toBe(302);
      expect((await agent(ap, E, fx.ids.p)).status).toBe(302);
    });
  });
});
