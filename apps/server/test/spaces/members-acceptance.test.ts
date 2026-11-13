import {
  ArtifactList,
  ContentGrant,
  CreatedShareLink,
  ProjectList,
  ProjectMember,
  PublishResult,
} from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderContentErrorPage } from '../../src/content/error-page.ts';
import { apiInit } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { type ErrorJson, type Reply, restClient } from '../helpers/rest.ts';
import { readSse, sampleAnchor } from '../helpers/review.ts';
import { listen } from '../helpers/socket.ts';
import {
  type CaseIds,
  type Person,
  type SpacesFixture,
  sameAnswer,
  spacesContext,
  spacesFixture,
  UNKNOWN_IDS,
} from './fixture.ts';

const RETRY = 'retry: 5000\n\n';

/** The grant token in a single-domain content URL, `…/c/<token>/`. */
function tokenIn(url: string): string {
  const token = /\/c\/([0-9a-hjkmnp-tv-z]{32})\/$/.exec(url)?.[1];
  if (token === undefined) throw new Error(`Not a content URL: ${url}`);
  return token;
}

/**
 * Spec §11 acceptance 9, through the API only: the owner A lets the stranger S into P as a viewer,
 * makes them an editor, and takes them out again. What P's members may do is the M10 role table;
 * the quota clause of the acceptance belongs to M12's quota test.
 */
describe.each(dialects)('acceptance 9: a person shared into a project on %s', (dialect) => {
  let ctx: TestContext;
  let server: Awaited<ReturnType<typeof listen>>;
  let fx: SpacesFixture;
  beforeAll(async () => {
    ctx = await spacesContext(dialect, 'personal');
    server = await listen(ctx.app, ctx.deps.config);
  });
  // Every test lets S in, so each gets its own fixture, in the shared context.
  beforeEach(async () => {
    fx = await spacesFixture(ctx);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await server?.close();
    await ctx?.close();
  });

  const api = (person: Person) => restClient(ctx, person.cookie);
  const membersPath = () => `/projects/${fx.ids.P}/members`;

  /** A lets S into P with `role`, by their email. */
  async function invite(role: 'editor' | 'viewer'): Promise<void> {
    const { A, S } = fx.people;
    const r = await api(A).post(membersPath(), { email: S.user.email, role });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(ProjectMember.parse(r.body)).toMatchObject({ user: { id: S.user.id }, role });
  }

  /** A gives S the role `role` in P. */
  async function makeS(role: 'editor' | 'viewer'): Promise<void> {
    const r = await api(fx.people.A).patch(`${membersPath()}/${fx.people.S.user.id}`, { role });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** The ids `person` gets listed for the artifacts of project `projectId`, or of every project. */
  async function artifactsOf(person: Person, projectId?: string): Promise<string[]> {
    const query = projectId === undefined ? '' : `?project_id=${projectId}`;
    const r = await api(person).get(`/artifacts${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ArtifactList.parse(r.body).items.map((artifact) => artifact.id);
  }

  /** The ids of `person`'s Recent. */
  async function recentOf(person: Person): Promise<string[]> {
    const r = await api(person).get('/artifacts/recent');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ArtifactList.parse(r.body).items.map((artifact) => artifact.id);
  }

  /** The reason of an error reply, if the body is one that has it. */
  const reasonOf = (r: Reply) => (r.body as Partial<ErrorJson> | null)?.error?.details?.reason;

  const inline = (projectId: string) => ({
    target: { project_id: projectId },
    files: [{ path: 'index.html', content: '<!doctype html><h1>From S</h1>' }],
  });

  test('a viewer sees that project only, comments, and cannot publish', async () => {
    const { A, S } = fx.people;
    const { ids } = fx;
    expect(await artifactsOf(S)).toEqual([]);
    await invite('viewer');

    const projects = await api(S).get('/projects');
    expect(projects.status, JSON.stringify(projects.body)).toBe(200);
    const listed = ProjectList.parse(projects.body).items;
    expect(listed.find((project) => project.id === ids.P)).toMatchObject({
      role: 'viewer',
      owner: { id: A.user.id },
    });
    expect(listed.map((project) => project.id)).not.toContain(ids.Q);

    const readP = await api(S).get(`/artifacts/${ids.p}`);
    expect(readP.status, JSON.stringify(readP.body)).toBe(200);
    const readQ = await api(S).get(`/artifacts/${ids.q}`);
    expect(readQ.status).toBe(404);
    sameAnswer(readQ, await api(S).get(`/artifacts/${UNKNOWN_IDS.q}`));
    expect(await artifactsOf(S)).toEqual(expect.arrayContaining([ids.p, ids.e]));
    expect(await artifactsOf(S)).not.toContain(ids.q);

    const commented = await api(S).post(`/artifacts/${ids.p}/comments`, {
      body: 'A viewer comments',
      anchor: sampleAnchor(),
    });
    expect(commented.status, JSON.stringify(commented.body)).toBe(201);

    const before = await artifactsOf(A, ids.P);
    const session = await api(S).post('/publish-sessions', { target: { project_id: ids.P } });
    expect(session.status, JSON.stringify(session.body)).toBe(403);
    expect(reasonOf(session)).toBe('role');
    const published = await api(S).post('/publish/inline', inline(ids.P));
    expect(published.status, JSON.stringify(published.body)).toBe(403);
    expect(reasonOf(published)).toBe('role');
    expect(await artifactsOf(A, ids.P)).toEqual(before);
  });

  test("an editor publishes there, into the owner's space", async () => {
    const { A, S } = fx.people;
    const { ids } = fx;
    await invite('viewer');
    await makeS('editor');

    const published = await api(S).post('/publish/inline', inline(ids.P));
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const { artifact_id: artifactId } = PublishResult.parse(published.body);

    // The artifact is in P, which A owns and S does not: it is in A's space, and counts for A.
    const stored = await ctx.deps.db.db
      .selectFrom('artifacts')
      .innerJoin('projects', 'projects.id', 'artifacts.project_id')
      .select(['artifacts.project_id', 'artifacts.created_by', 'projects.owner_id'])
      .where('artifacts.id', '=', artifactId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ project_id: ids.P, created_by: S.user.id, owner_id: A.user.id });
    expect(await artifactsOf(A, ids.P)).toContain(artifactId);
    const ownedByS = await ctx.deps.db.db
      .selectFrom('artifacts')
      .innerJoin('projects', 'projects.id', 'artifacts.project_id')
      .select('artifacts.id')
      .where('projects.owner_id', '=', S.user.id)
      .execute();
    expect(ownedByS).toEqual([]);
  });

  test('after removal the review tab, the stream and the links in that project are gone', async () => {
    // The heartbeat never comes: whatever ends, the removal itself ended.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { A, S } = fx.people;
    const { ids } = fx;
    await invite('editor');

    const preview = await api(S).get(`/artifacts/${ids.p}/versions/1/preview?mode=review`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const grant = tokenIn(ContentGrant.parse(preview.body).url);
    const content = async () => {
      const res = await fetchContent(ctx, grant, 'index.html');
      return { status: res.status, body: await res.text() };
    };
    expect((await content()).status).toBe(200);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/artifacts/${ids.p}/events`, {
      headers: { cookie: S.cookie },
    });
    expect(res.status, res.status === 200 ? '' : await res.text()).toBe(200);
    const stream = readSse(res);
    expect(await stream.next()).toBe(RETRY);

    const made = await api(S).post(`/artifacts/${ids.p}/share-links`, { allow_comments: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const link = CreatedShareLink.parse(made.body).token;
    const shared = async () => {
      const r = await ctx.request(`/api/v1/share/${link}`, apiInit(ctx));
      return { status: r.status, body: await r.json() };
    };
    expect((await shared()).status).toBe(200);
    expect(await recentOf(S)).toContain(ids.p);

    const removed = await api(A).del(`${membersPath()}/${S.user.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    expect(await content()).toEqual({ status: 410, body: renderContentErrorPage('gone') });
    expect(await stream.done()).toBe(true);
    expect(await shared()).toMatchObject({
      status: 410,
      body: { error: { details: { reason: 'revoked' } } },
    });
    expect(await recentOf(S)).not.toContain(ids.p);
    const readP = await api(S).get(`/artifacts/${ids.p}`);
    expect(readP.status).toBe(404);
    sameAnswer(readP, await api(S).get(`/artifacts/${UNKNOWN_IDS.p}`));
  });

  test("none of it reaches the owner's other project", async () => {
    await invite('editor');
    const probes: [string, (ids: CaseIds) => Promise<Reply>][] = [
      ['read q', (ids) => api(fx.people.S).get(`/artifacts/${ids.q}`)],
      [
        'a publish session into Q',
        (ids) => api(fx.people.S).post('/publish-sessions', { target: { project_id: ids.Q } }),
      ],
      [
        'a link on q',
        (ids) =>
          api(fx.people.S).post(`/artifacts/${ids.q}/share-links`, { allow_comments: false }),
      ],
      ['the members of Q', (ids) => api(fx.people.S).get(`/projects/${ids.Q}/members`)],
    ];
    for (const [name, send] of probes) {
      const answer = await send(fx.ids);
      expect(answer.status, `${name}: ${JSON.stringify(answer.body)}`).toBe(404);
      sameAnswer(answer, await send(UNKNOWN_IDS));
    }
  });
});
