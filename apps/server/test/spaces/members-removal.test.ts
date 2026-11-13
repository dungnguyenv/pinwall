import { ArtifactList, CommentThreadList, ContentGrant, PublishSession } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderContentErrorPage } from '../../src/content/error-page.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { SSE_HEARTBEAT_MS } from '../../src/http/sse.ts';
import { InMemoryOneTimeStore } from '../../src/infra/one-time-store.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { newSecret } from '../../src/lib/ids.ts';
import { apiInit } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { readSse } from '../helpers/review.ts';
import { listen } from '../helpers/socket.ts';
import {
  type Person,
  type SpacesFixture,
  sameAnswer,
  spacesClient,
  spacesContext,
  spacesFixture,
  T,
} from './fixture.ts';

const RETRY = 'retry: 5000\n\n';
/** How long a stream that should stay open is watched for an end. */
const STAYS_OPEN_MS = 300;

/** Only the heartbeat's interval is faked: sockets, the database and `readSse` keep real time. */
const fakeHeartbeat = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
/** Moves the faked interval on to the next heartbeat: a ping, then the access check. */
const heartbeat = () => vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);

/** The grant token in a single-domain content URL, `…/c/<token>/`. */
function tokenIn(url: string): string {
  const token = /\/c\/([0-9a-hjkmnp-tv-z]{32})\/$/.exec(url)?.[1];
  if (token === undefined) throw new Error(`Not a content URL: ${url}`);
  return token;
}

describe('InMemoryOneTimeStore', () => {
  test('deleteMatching removes only the matching entries of a group', async () => {
    const store = new InMemoryOneTimeStore(new FixedClock(T));
    await store.put('k1', { hit: true }, 60_000, { group: 'g' });
    await store.put('k2', { hit: true }, 60_000, { group: 'g' });
    await store.put('k3', { hit: false }, 60_000, { group: 'g' });
    await store.put('k4', { hit: true }, 60_000, { group: 'h' });

    const removed = await store.deleteMatching(
      'g',
      (_key, value) => (value as { hit: boolean }).hit,
    );
    expect(removed.sort()).toEqual(['k1', 'k2']);
    expect(await store.peek('k1')).toBeNull();
    expect(await store.peek('k2')).toBeNull();
    expect(await store.peek('k3')).toEqual({ hit: false });
    expect(await store.peek('k4')).toEqual({ hit: true });
  });
});

describe.each(dialects)('removing a project member on %s', (dialect) => {
  let ctx: TestContext;
  let server: Awaited<ReturnType<typeof listen>>;
  let fx: SpacesFixture;
  beforeAll(async () => {
    ctx = await spacesContext(dialect, 'personal');
    server = await listen(ctx.app, ctx.deps.config);
  });
  // Tests take people out of P, so each gets its own fixture, in the shared context.
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

  const api = (person: Person) => spacesClient(ctx, person.cookie);
  const memberPath = (person: Person) => `/projects/${fx.ids.P}/members/${person.user.id}`;

  /** `owner` takes `person` out of P, or `person` leaves when they are the same. */
  async function remove(owner: Person, person: Person): Promise<void> {
    const r = await api(owner).del(memberPath(person));
    expect(r.status, JSON.stringify(r.body)).toBe(204);
  }

  /** A gives `person` the role `role` in P. */
  async function setRole(person: Person, role: 'editor' | 'viewer'): Promise<void> {
    const r = await api(fx.people.A).patch(memberPath(person), { role });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** A lets `person` into P again, by their email, as an editor. */
  async function readd(person: Person): Promise<void> {
    const r = await api(fx.people.A).post(`/projects/${fx.ids.P}/members`, {
      email: person.user.email,
      role: 'editor',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }

  /** An artifact `person` publishes into their own default project: somewhere other than P. */
  async function elsewhere(person: Person): Promise<string> {
    const { artifact } = await publishFiles(ctx, person.user, {
      'index.html': '<!doctype html><h1>Elsewhere</h1>',
    });
    return artifact.id;
  }

  /** A grant of `mode` that `person` gets on version 1 of the artifact, through the preview. */
  async function grantOf(person: Person, artifactId: string, mode: 'review' | 'raw') {
    const r = await ctx.request(
      `/api/v1/artifacts/${artifactId}/versions/1/preview?mode=${mode}`,
      apiInit(ctx, { cookie: person.cookie }),
    );
    expect(r.status, await r.clone().text()).toBe(200);
    return tokenIn(ContentGrant.parse(await r.json()).url);
  }

  /** The content at `index.html` of grant `token`: its status and page. */
  async function served(token: string): Promise<{ status: number; body: string }> {
    const res = await fetchContent(ctx, token, 'index.html');
    return { status: res.status, body: await res.text() };
  }

  const goneContent = { status: 410, body: renderContentErrorPage('gone') };

  /** A link by `maker` that follows the current version, with no password, open to comments. */
  async function linkTo(maker: Person, artifactId: string) {
    return createShareLink(ctx.deps, maker.user, artifactId, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: true,
    });
  }

  /** The share viewer's info for `token`, as a guest asks for it. */
  async function shareInfo(token: string): Promise<{ status: number; body: unknown }> {
    const res = await ctx.request(`/api/v1/share/${token}`, apiInit(ctx));
    return { status: res.status, body: await res.json() };
  }

  async function expectRevoked(token: string): Promise<void> {
    expect(await shareInfo(token)).toMatchObject({
      status: 410,
      body: { error: { details: { reason: 'revoked' } } },
    });
  }

  async function expectOpens(token: string): Promise<void> {
    const r = await shareInfo(token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  /** When the link `linkId` was revoked, or null. */
  async function revokedAt(linkId: string): Promise<number | null> {
    const row = await ctx.deps.db.db
      .selectFrom('share_links')
      .select('revoked_at')
      .where('id', '=', linkId)
      .executeTakeFirstOrThrow();
    return row.revoked_at;
  }

  /** A stream read past its `retry` line; `res` must have answered 200. */
  async function opened(res: Response) {
    expect(res.status, res.status === 200 ? '' : await res.text()).toBe(200);
    const s = readSse(res);
    expect(await s.next()).toBe(RETRY);
    return s;
  }

  /** `person`'s member stream on the artifact, over a real socket. */
  const memberStream = async (artifactId: string, person: Person) =>
    opened(
      await fetch(`http://127.0.0.1:${server.port}/api/v1/artifacts/${artifactId}/events`, {
        headers: { cookie: person.cookie },
      }),
    );

  /** A guest's stream on the share link `token`, over a real socket. */
  const guestStream = async (token: string) =>
    opened(await fetch(`http://127.0.0.1:${server.port}/api/v1/share/${token}/events`));

  test("removal ends the member's grants for the project at once, for good", async () => {
    const { E } = fx.people;
    const other = await elsewhere(E);
    const inP = [await grantOf(E, fx.ids.p, 'review'), await grantOf(E, fx.ids.p, 'raw')];
    const kept = await grantOf(E, other, 'review');
    for (const token of [...inP, kept]) expect((await served(token)).status).toBe(200);

    await remove(fx.people.A, E);
    for (const token of inP) expect(await served(token)).toEqual(goneContent);
    const rows = await ctx.deps.db.db
      .selectFrom('content_grants')
      .innerJoin('versions', 'versions.id', 'content_grants.version_id')
      .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
      .select('content_grants.token')
      .where('content_grants.user_id', '=', E.user.id)
      .where('artifacts.project_id', '=', fx.ids.P)
      .execute();
    expect(rows).toEqual([]);
    expect((await served(kept)).status).toBe(200);

    // Back in P, E gets new grants; the old ones stay gone.
    await readd(E);
    for (const token of inP) expect(await served(token)).toEqual(goneContent);
  });

  test("removal ends the member's live streams on the project at once", async () => {
    fakeHeartbeat();
    const { E } = fx.people;
    const other = await elsewhere(E);
    const inP = await memberStream(fx.ids.p, E);
    const kept = await memberStream(other, E);

    await remove(fx.people.A, E);
    // No heartbeat has come: the removal itself ended it.
    expect(await inP.done()).toBe(true);
    expect(await kept.done(STAYS_OPEN_MS)).toBe(false);
    await kept.cancel();
  });

  test("removal drops the member's unused upload URLs into the project", async () => {
    const { E } = fx.people;
    const session = async (target: Record<string, string>) => {
      const r = await api(E).post<PublishSession>('/publish-sessions', { target });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return new URL(PublishSession.parse(r.body).upload_url).pathname;
    };
    const newVersion = await session({ artifact_id: fx.ids.p, expected_version_id: fx.ids.pV2 });
    const intoP = await session({ project_id: fx.ids.P });
    const own = await session({});

    await remove(fx.people.A, E);
    const upload = async (path: string) => {
      const res = await ctx.request(path, {
        method: 'POST',
        body: '<!doctype html><h1>Late</h1>',
        headers: { 'content-type': 'text/html' },
      });
      return { status: res.status, body: await res.json() };
    };
    const unknown = await upload(`/upload/${newSecret()}`);
    expect(unknown).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: t('publish.session.unknown') } },
    });
    for (const path of [newVersion, intoP]) sameAnswer(await upload(path), unknown);
    expect((await upload(own)).status).toBe(201);
  });

  test('removal revokes the share links the member made in the project', async () => {
    fakeHeartbeat();
    const { A, E } = fx.people;
    const other = await elsewhere(E);
    const onE = await linkTo(E, fx.ids.e);
    const onP = await linkTo(E, fx.ids.p);
    const eElsewhere = await linkTo(E, other);
    const aOnP = await linkTo(A, fx.ids.p);
    const guest = await guestStream(onE.token);

    await remove(A, E);
    for (const link of [onE, onP]) {
      await expectRevoked(link.token);
      expect(await revokedAt(link.row.id)).toBe(T);
    }
    // No heartbeat has come: the revoke itself ended it.
    expect(await guest.done()).toBe(true);
    for (const link of [aOnP, eElsewhere]) {
      await expectOpens(link.token);
      expect(await revokedAt(link.row.id)).toBeNull();
    }

    // Revoked, not suspended: E back in P does not open them again.
    await readd(E);
    for (const link of [onE, onP]) await expectRevoked(link.token);
  });

  test('their comments and artifacts stay', async () => {
    const { A, E } = fx.people;
    await remove(A, E);

    const threads = await api(A).get<CommentThreadList>(`/artifacts/${fx.ids.p}/comments`);
    expect(threads.status, JSON.stringify(threads.body)).toBe(200);
    const ids = CommentThreadList.parse(threads.body).items.map((thread) => thread.id);
    expect(ids).toContain(fx.ids.eThread);

    const e = await api(A).get<{ project_id: string; created_by: string | null }>(
      `/artifacts/${fx.ids.e}`,
    );
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body).toMatchObject({ project_id: fx.ids.P, created_by: E.user.id });
  });

  test("Recent forgets the project's artifacts", async () => {
    const { A, E } = fx.people;
    const recent = async () => {
      const r = await api(E).get('/artifacts/recent');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return ArtifactList.parse(r.body).items.map((artifact) => artifact.id);
    };
    await grantOf(E, fx.ids.p, 'review');
    expect(await recent()).toContain(fx.ids.p);

    await remove(A, E);
    expect(await recent()).not.toContain(fx.ids.p);
  });

  test('leaving has the same effects', async () => {
    fakeHeartbeat();
    const { V } = fx.people;
    const grant = await grantOf(V, fx.ids.p, 'review');
    const stream = await memberStream(fx.ids.p, V);

    await remove(V, V);
    expect(await served(grant)).toEqual(goneContent);
    expect(await stream.done()).toBe(true);
  });

  test('demoting an editor to a viewer revokes their links in the project and nothing else', async () => {
    fakeHeartbeat();
    const { E } = fx.people;
    const links = [await linkTo(E, fx.ids.e), await linkTo(E, fx.ids.p)];
    const guests = [];
    for (const link of links) guests.push(await guestStream(link.token));
    const grant = await grantOf(E, fx.ids.p, 'review');
    const own = await memberStream(fx.ids.p, E);

    await setRole(E, 'viewer');
    for (const link of links) {
      await expectRevoked(link.token);
      expect(await revokedAt(link.row.id)).toBe(T);
    }
    for (const guest of guests) expect(await guest.done()).toBe(true);
    expect((await served(grant)).status).toBe(200);
    // A viewer still sees p: not even the next access check ends E's own stream.
    await heartbeat();
    expect(await own.done(STAYS_OPEN_MS)).toBe(false);
    await own.cancel();
    const p = await api(E).get(`/artifacts/${fx.ids.p}`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  });

  test('a role change that changes nothing ends nothing', async () => {
    const { A, E, V } = fx.people;
    const links = [await linkTo(E, fx.ids.e), await linkTo(E, fx.ids.p), await linkTo(A, fx.ids.p)];

    await setRole(E, 'editor');
    await setRole(V, 'editor');
    for (const link of links) {
      await expectOpens(link.token);
      expect(await revokedAt(link.row.id)).toBeNull();
    }
  });
});
