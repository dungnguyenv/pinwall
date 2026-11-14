import { ContentGrant, ShareInfo } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Visibility } from '../../src/config/types.ts';
import { createProject } from '../../src/domain/projects.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import {
  addMember,
  MODES,
  type Person,
  type SpacesFixture,
  sameAnswer,
  spacesFixture,
} from '../spaces/fixture.ts';
import { approve, contextWith, moderationContext } from './helpers.ts';

/**
 * With PINWALL_SHARE_LINKS=approved, content leaves Pinwall only when both the person who holds or
 * makes the URL may expose content and the version itself is exposable: its publisher may expose,
 * or, in personal mode, the owner of its project may. An approved person who opens, links or
 * raw-links a page an unapproved person published exposes nothing.
 */

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** The refusal of a version nobody who may expose stands behind, as REST answers it. */
const notExposableBody = (what: 'shareLink' | 'rawLink') => ({
  error: {
    code: 'forbidden',
    message: t(`spaces.exposure.${what}Version`),
    details: { reason: 'version_not_exposable' },
  },
});

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

/** A load of a grant's entry as `destination` (`Sec-Fetch-Dest`), or without fetch metadata. */
function load(c: TestContext, token: string, destination?: string): Promise<Response> {
  return fetchContent(c, token, '', {
    headers: destination === undefined ? {} : { 'sec-fetch-dest': destination },
  });
}

/** `person`'s grant from the preview API on version `n` of `artifactId`, asked through `c`. */
async function previewGrant(
  c: TestContext,
  person: Person,
  artifactId: string,
  n: number,
  mode: 'review' | 'raw' = 'review',
): Promise<string> {
  const r = await c.request(
    `/api/v1/artifacts/${artifactId}/versions/${n}/preview?mode=${mode}`,
    apiInit(c, { cookie: person.cookie }),
  );
  expect(r.status, await r.clone().text()).toBe(200);
  return tokenIn(ContentGrant.parse(await r.json()).url);
}

/** Whether grant `token` opens as a page of its own through `c` (200) or only in a frame (403). */
async function topLevel(c: TestContext, token: string): Promise<number> {
  const res = await load(c, token, 'document');
  await res.body?.cancel();
  return res.status;
}

/** `person`'s raw link to `artifactId`, followed in a browser (`accept` HTML) and by an agent. */
async function rawLinks(c: TestContext, person: Person, artifactId: string) {
  const browser = await c.request(`/a/${artifactId}/raw`, {
    headers: { cookie: person.cookie, accept: BROWSER },
    redirect: 'manual',
  });
  const agent = await c.request(`/a/${artifactId}/raw`, {
    headers: { authorization: `Bearer ${person.token}` },
    redirect: 'manual',
  });
  return { browser, agent };
}

/** How a share link's page, its "Open original" and the share viewer's info answer through `c`. */
async function linkAnswers(c: TestContext, token: string) {
  return [
    await answerOf(await c.request(`/s/${token}`, { redirect: 'manual' })),
    await answerOf(await c.request(`/s/${token}/original`, { redirect: 'manual' })),
    await answerOf(await c.request(`/api/v1/share/${token}`, apiInit(c))),
  ];
}

const OPEN = [302, 302, 200];
const statusesOf = (answers: { status: number }[]) => answers.map((a) => a.status);

describe.each(dialects)('exposure judged by who published, on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode: Visibility) => {
    // `ctx` lets every member share, as 1.0 does; `ap` is the same instance with
    // PINWALL_SHARE_LINKS=approved.
    let ctx: TestContext;
    let ap: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, mode);
      ap = contextWith(ctx, { shareLinks: 'approved' });
    });
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    /** A project of `owner`'s, in which `editors` may publish (personal mode; team mode needs none). */
    async function projectOf(owner: Person, editors: Person[] = []): Promise<string> {
      const project = await createProject(ctx.deps, owner.user, { name: 'Abuse report' });
      for (const editor of editors) {
        await addMember(ctx, project.id, editor.user.id, 'editor', owner.user.id);
      }
      return project.id;
    }

    /** A new artifact `actor` publishes in `projectId`: its id and version 1's. */
    async function artifactIn(actor: Person, projectId: string) {
      const { artifact, version } = await publishFiles(
        ctx,
        actor.user,
        { 'index.html': `<!doctype html><h1>By ${actor.user.name}</h1>` },
        { kind: 'new_artifact', projectId, name: null, tags: [] },
      );
      return { id: artifact.id, v1: version.id };
    }

    /** A new version of `artifactId` on top of `expectedVersionId`, published by `actor`. */
    async function nextVersion(actor: Person, artifactId: string, expectedVersionId: string) {
      const { version } = await publishFiles(
        ctx,
        actor.user,
        { 'index.html': `<!doctype html><h1>Now by ${actor.user.name}</h1>` },
        { kind: 'new_version', artifactId, expectedVersionId },
      );
      return version.id;
    }

    /** A link `maker` makes through `c`'s REST API: the reply, with the token when made. */
    function linkOver(c: TestContext, maker: Person, artifactId: string, versionId?: string) {
      return restClient(c, maker.cookie).post<{ token: string }>(
        `/artifacts/${artifactId}/share-links`,
        versionId === undefined ? {} : { version_id: versionId },
      );
    }

    test("an approved admin added to a stranger's project gets only framed grants of the stranger's page, and no raw link", async () => {
      const { S, X } = fx.people;
      // The review's attack: stranger S publishes a page, then adds the admin to the project.
      // In team mode the admin sees it without being asked.
      const project = await projectOf(S);
      const page = await artifactIn(S, project);
      if (mode === 'personal') {
        const added = await restClient(ap, S.cookie).post(`/projects/${project}/members`, {
          email: X.user.email,
          role: 'viewer',
        });
        expect(added.status, JSON.stringify(added.body)).toBe(201);
      }

      const review = await previewGrant(ap, X, page.id, 1);
      // The admin still reviews the page inside Pinwall's viewer…
      const framed = await load(ap, review, 'iframe');
      expect(framed.status).toBe(200);
      expect(framed.headers.get('content-security-policy')).toContain('frame-ancestors');
      expect(await framed.text()).toContain('By S');
      // …but the URL the page's script can read does not open it as a page of its own.
      for (const destination of ['document', undefined]) {
        const refused = await load(ap, review, destination);
        expect(refused.status, `as ${destination}`).toBe(403);
        expect(await refused.text()).toContain(t('content.framedOnly.title'));
      }
      expect(await topLevel(ap, await previewGrant(ap, X, page.id, 1, 'raw'))).toBe(403);

      const raw = await rawLinks(ap, X, page.id);
      expect(raw.browser.status).toBe(403);
      expect(raw.browser.headers.get('content-type')).toBe('text/html; charset=UTF-8');
      expect(await raw.browser.text()).toContain(t('spaces.exposure.rawLinkVersion'));
      expect(await answerOf(raw.agent)).toEqual({ status: 403, body: notExposableBody('rawLink') });

      if (mode === 'team') {
        // Anyone may link any artifact in team mode; an approved admin still cannot link this one.
        const link = await linkOver(ap, X, page.id);
        expect(link).toMatchObject({ status: 403, body: notExposableBody('shareLink') });
      }

      // With PINWALL_SHARE_LINKS=members nothing of this applies, as in 1.0.
      expect(await topLevel(ctx, await previewGrant(ctx, X, page.id, 1))).toBe(200);
      expect((await rawLinks(ctx, X, page.id)).browser.status).toBe(302);

      // Judged at each request: once S is approved, the same grant opens as a page.
      await approve(ctx, S.user.id);
      expect(await topLevel(ap, review)).toBe(200);
      expect((await rawLinks(ap, X, page.id)).browser.status).toBe(302);
    });

    test("an approved owner exposes what an unapproved editor published in the owner's project, in personal mode only", async () => {
      const { A, E } = fx.people;
      // e is E's artifact in A's project P; neither A nor E is approved yet.
      await approve(ctx, A.user.id);
      const exposed = mode === 'personal';

      expect(await topLevel(ap, await previewGrant(ap, A, fx.ids.e, 1))).toBe(exposed ? 200 : 403);
      const raw = await rawLinks(ap, A, fx.ids.e);
      expect(raw.browser.status).toBe(exposed ? 302 : 403);
      expect(raw.agent.status).toBe(exposed ? 302 : 403);
      const link = await linkOver(ap, A, fx.ids.e);
      if (exposed) {
        expect(link.status).toBe(201);
        expect(statusesOf(await linkAnswers(ap, link.body.token))).toEqual(OPEN);
      } else {
        expect(link).toMatchObject({ status: 403, body: notExposableBody('shareLink') });
      }

      // E's own grant follows E's approval, whoever owns the project.
      expect(await topLevel(ap, await previewGrant(ap, E, fx.ids.e, 1))).toBe(403);
    });

    test('a link cannot be made to a version that is not exposable, by an approved person either', async () => {
      const { S, X } = fx.people;
      const project = await projectOf(S, [X]);
      const page = await artifactIn(S, project);
      const v2 = await nextVersion(X, page.id, page.v1);

      // The current version is X's (an admin's): a link that follows it can be made.
      const following = await linkOver(ap, X, page.id);
      expect(following.status, JSON.stringify(following.body)).toBe(201);
      expect((await linkOver(ap, X, page.id, v2)).status).toBe(201);
      // Version 1 is S's alone.
      expect(await linkOver(ap, X, page.id, page.v1)).toMatchObject({
        status: 403,
        body: notExposableBody('shareLink'),
      });
      // Once S publishes the current version, a link that would follow it cannot be made.
      await nextVersion(S, page.id, v2);
      expect(await linkOver(ap, X, page.id)).toMatchObject({
        status: 403,
        body: notExposableBody('shareLink'),
      });

      // With PINWALL_SHARE_LINKS=members, as in 1.0.
      expect((await linkOver(ctx, X, page.id)).status).toBe(201);
      expect((await linkOver(ctx, X, page.id, page.v1)).status).toBe(201);
    });

    test('a link that follows the current version answers like a revoked one once an unapproved person publishes it', async () => {
      const { S, X } = fx.people;
      const project = await projectOf(S, [X]);
      const page = await artifactIn(X, project);
      const make = (versionId: string | null) =>
        createShareLink(ap.deps, X.user, page.id, {
          versionId,
          password: null,
          expiresAt: null,
          allowComments: false,
        });
      const following = await make(null);
      const pinned = await make(page.v1);
      const revoked = await make(null);
      await revokeShareLink(ap.deps, X.user, revoked.row.id);
      expect(statusesOf(await linkAnswers(ap, following.token))).toEqual(OPEN);

      await nextVersion(S, page.id, page.v1);
      const refused = await linkAnswers(ap, following.token);
      const asRevoked = await linkAnswers(ap, revoked.token);
      expect(statusesOf(refused)).toEqual([410, 410, 410]);
      refused.forEach((answer, i) => {
        sameAnswer(answer, asRevoked[i] ?? { status: 0, body: null });
      });
      // A link to X's own version still opens.
      expect(statusesOf(await linkAnswers(ap, pinned.token))).toEqual(OPEN);
      // With PINWALL_SHARE_LINKS=members, as in 1.0.
      expect(statusesOf(await linkAnswers(ctx, following.token))).toEqual(OPEN);

      // Suspended, not revoked: it opens again once S is approved.
      await approve(ctx, S.user.id);
      expect(statusesOf(await linkAnswers(ap, following.token))).toEqual(OPEN);
    });

    test('a share-link grant stops serving once the version it shows is no longer exposable', async () => {
      const { E, S, X } = fx.people;
      await approve(ctx, E.user.id);
      const project = await projectOf(S, [E, X]);
      const page = await artifactIn(E, project);
      const { token } = await createShareLink(ap.deps, X.user, page.id, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: false,
      });
      const info = await ap.request(`/api/v1/share/${token}`, apiInit(ap));
      expect(info.status).toBe(200);
      const grant = tokenIn(ShareInfo.parse(await info.json()).content.url);
      expect(await topLevel(ap, grant)).toBe(200);

      // E, who published it, loses approval: the link and the grant it gave stop at once.
      await approve(ctx, E.user.id, false);
      for (const destination of ['document', 'iframe']) {
        const res = await load(ap, grant, destination);
        expect(res.status, `as ${destination}`).toBe(410);
        await res.body?.cancel();
      }
      expect(statusesOf(await linkAnswers(ap, token))).toEqual([410, 410, 410]);
      expect(await topLevel(ctx, grant)).toBe(200);

      await approve(ctx, E.user.id);
      expect(await topLevel(ap, grant)).toBe(200);
    });
  });
});
