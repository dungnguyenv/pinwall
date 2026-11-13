import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { Visibility } from '../../src/config/types.ts';
import type { DbDialect } from '../../src/db/connect.ts';
import type { MemberRole, UserRow } from '../../src/db/schema.ts';
import type { AppDeps } from '../../src/deps.ts';
import { addReply, type CommentActor, createThread } from '../../src/domain/comments.ts';
import { createProject } from '../../src/domain/projects.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import type { IdPrefix } from '../../src/lib/ids.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, type Reply, restClient } from '../helpers/rest.ts';
import { sampleAnchor } from '../helpers/review.ts';

/** Both visibility modes, for `describe.each`: the same suite runs in each. */
export const MODES: readonly Visibility[] = ['team', 'personal'];

/** The same deps, running in `visibility`: the database and everything else stay shared. */
export function withVisibility(deps: AppDeps, visibility: Visibility): AppDeps {
  return { ...deps, config: { ...deps.config, visibility } };
}

/** The time a `spacesContext` clock starts at. */
export const T = Date.UTC(2026, 10, 13);

/**
 * An app in `visibility` mode whose clock stands at `T` until a test moves it, with `env` on top
 * of the test defaults.
 */
export function spacesContext(
  dialect: DbDialect,
  visibility: Visibility,
  env: Record<string, string> = {},
): Promise<TestContext> {
  return createTestContext({
    dialect,
    clock: new FixedClock(T),
    env: { ...env, PINWALL_VISIBILITY: visibility },
  });
}

/**
 * The people of the IDOR fixture: A owns P and Q, E edits P, V views P, S is a stranger to both,
 * and X is an admin who is a stranger too.
 */
export type Who = 'A' | 'E' | 'V' | 'S' | 'X';

/** A signed-in person, with a session cookie and an API token. */
export interface Person {
  user: UserRow;
  cookie: string;
  token: string;
}

/**
 * The fixture's ids. Projects P and Q belong to A; artifacts p (in P) and q (in Q) are A's, with
 * two versions each; e (in P) is E's, with one. Threads: A's on version 1 of p (with A's reply)
 * and of q, and E's on the current version of p. Share links: A's on p and q, E's on e.
 */
export interface CaseIds {
  P: string;
  Q: string;
  p: string;
  q: string;
  e: string;
  pV1: string;
  pV2: string;
  qV2: string;
  pThread: string;
  pReply: string;
  qThread: string;
  eThread: string;
  pLink: string;
  qLink: string;
  eLink: string;
}

/** An id of the given kind that names nothing: the answer every invisible id must match. */
const unknownId = (prefix: IdPrefix) => `${prefix}_${'z'.repeat(20)}`;

/** Ids of the right kinds and shape that exist nowhere (never the default project's id). */
export const UNKNOWN_IDS: CaseIds = {
  P: unknownId('prj'),
  Q: unknownId('prj'),
  p: unknownId('art'),
  q: unknownId('art'),
  e: unknownId('art'),
  pV1: unknownId('ver'),
  pV2: unknownId('ver'),
  qV2: unknownId('ver'),
  pThread: unknownId('cmt'),
  pReply: unknownId('cmt'),
  qThread: unknownId('cmt'),
  eThread: unknownId('cmt'),
  pLink: unknownId('shr'),
  qLink: unknownId('shr'),
  eLink: unknownId('shr'),
};

export interface SpacesFixture {
  people: Record<Who, Person>;
  ids: CaseIds;
}

/** An oidc member named `who` (an oidc admin for X), signed in, with an API token. */
async function signIn(ctx: TestContext, who: Who): Promise<Person> {
  const { user, cookie } = await createSignedInUser(ctx, {
    kind: 'oidc',
    name: who,
    ...(who === 'X' ? { idpRole: 'admin' } : {}),
  });
  return { user, cookie, token: await createUserToken(ctx, user.id) };
}

/** A PNG signature followed by random bytes, NUL included. */
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0]),
    randomBytes(200),
  ]);

/** Version `n` of an artifact: a page whose preview image is `cover`, and notes. */
const filesOf = (n: number, cover: Buffer) => ({
  'index.html': `<!doctype html><meta property="og:image" content="cover.png"><h1>Version ${n}</h1>`,
  'cover.png': cover,
  'notes.md': `# Notes\n\nVersion ${n}.\n`,
});

/** Publishes version 1 of a new artifact in `projectId` as `actor`. */
async function newArtifact(
  ctx: TestContext,
  actor: UserRow,
  projectId: string,
): Promise<{ id: string; v1: string; cover: Buffer }> {
  const cover = png();
  const { artifact, version } = await publishFiles(ctx, actor, filesOf(1, cover), {
    kind: 'new_artifact',
    projectId,
    name: null,
    tags: [],
  });
  return { id: artifact.id, v1: version.id, cover };
}

/** Publishes version 2 of `artifact` as `actor`: the page and the notes change, the image stays. */
async function secondVersion(
  ctx: TestContext,
  actor: UserRow,
  artifact: { id: string; v1: string; cover: Buffer },
): Promise<string> {
  const { version } = await publishFiles(ctx, actor, filesOf(2, artifact.cover), {
    kind: 'new_version',
    artifactId: artifact.id,
    expectedVersionId: artifact.v1,
  });
  return version.id;
}

const member = (p: Person): CommentActor => ({ kind: 'member', user: p.user });

/** A thread by `author` on version `versionId` of the artifact, or on its current version. */
async function threadOn(
  ctx: TestContext,
  author: Person,
  artifactId: string,
  versionId: string | null,
): Promise<string> {
  const thread = await createThread(ctx.deps, member(author), artifactId, {
    body: `A thread by ${author.user.name}`,
    anchor: sampleAnchor(),
    versionId,
  });
  return thread.id;
}

/** A link by `maker` that follows the current version, with no password, open to comments. */
async function linkTo(ctx: TestContext, maker: Person, artifactId: string): Promise<string> {
  const { row } = await createShareLink(ctx.deps, maker.user, artifactId, {
    versionId: null,
    password: null,
    expiresAt: null,
    allowComments: true,
  });
  return row.id;
}

/**
 * Builds the IDOR fixture through the domain functions, as each person: new people, projects and
 * content on every call, so several fixtures can share one context. E and V join P before any
 * content exists.
 */
export async function spacesFixture(ctx: TestContext): Promise<SpacesFixture> {
  const people: Record<Who, Person> = {
    A: await signIn(ctx, 'A'),
    E: await signIn(ctx, 'E'),
    V: await signIn(ctx, 'V'),
    S: await signIn(ctx, 'S'),
    X: await signIn(ctx, 'X'),
  };
  const { A, E, V } = people;
  const P = await createProject(ctx.deps, A.user, { name: 'P' });
  const Q = await createProject(ctx.deps, A.user, { name: 'Q' });
  await addMember(ctx, P.id, E.user.id, 'editor', A.user.id);
  await addMember(ctx, P.id, V.user.id, 'viewer', A.user.id);

  const p = await newArtifact(ctx, A.user, P.id);
  const pV2 = await secondVersion(ctx, A.user, p);
  const q = await newArtifact(ctx, A.user, Q.id);
  const qV2 = await secondVersion(ctx, A.user, q);
  const e = await newArtifact(ctx, E.user, P.id);

  const pThread = await threadOn(ctx, A, p.id, p.v1);
  const { comment: pReply } = await addReply(ctx.deps, member(A), pThread, 'A reply by A');
  const qThread = await threadOn(ctx, A, q.id, q.v1);
  const eThread = await threadOn(ctx, E, p.id, null);

  return {
    people,
    ids: {
      P: P.id,
      Q: Q.id,
      p: p.id,
      q: q.id,
      e: e.id,
      pV1: p.v1,
      pV2,
      qV2,
      pThread,
      pReply: pReply.id,
      qThread,
      eThread,
      pLink: await linkTo(ctx, A, p.id),
      qLink: await linkTo(ctx, A, q.id),
      eLink: await linkTo(ctx, E, e.id),
    },
  };
}

/** Lets `userId` into the project with `role`, as `addedBy` would. */
export async function addMember(
  ctx: TestContext,
  projectId: string,
  userId: string,
  role: MemberRole,
  addedBy: string,
): Promise<void> {
  await ctx.deps.db.db
    .insertInto('project_members')
    .values({
      project_id: projectId,
      user_id: userId,
      role,
      added_by: addedBy,
      created_at: ctx.deps.clock.now(),
    })
    .execute();
}

/** Takes `userId` out of the project's members. */
export async function removeMember(
  ctx: TestContext,
  projectId: string,
  userId: string,
): Promise<void> {
  await ctx.deps.db.db
    .deleteFrom('project_members')
    .where('project_id', '=', projectId)
    .where('user_id', '=', userId)
    .execute();
}

/**
 * `restClient`, plus `form`: a multipart POST to `/api/v1`, sent as a browser on the app's own
 * origin sends a form, with the body parsed as JSON.
 */
export function spacesClient(ctx: TestContext, cookie: string) {
  return {
    ...restClient(ctx, cookie),
    async form<T = unknown>(path: string, form: FormData): Promise<Reply<T>> {
      const encoded = new Response(form);
      const res = await ctx.request(`/api/v1${path}`, {
        method: 'POST',
        body: Buffer.from(await encoded.arrayBuffer()),
        headers: {
          cookie,
          origin: ctx.deps.config.publicOrigin,
          'content-type': encoded.headers.get('content-type') ?? '',
        },
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        body: (text === '' ? null : JSON.parse(text)) as T,
      };
    },
  };
}

export type RestApi = ReturnType<typeof spacesClient>;

/** One request of an IDOR table and the status it must get in each mode. */
export interface Case {
  name: string;
  who: Who;
  /** The request, built from the fixture's ids and, for routes that name a person, its people. */
  send: (api: RestApi, ids: CaseIds, people: Record<Who, Person>) => Promise<Reply>;
  team: number;
  personal: number;
  /** details.reason of a personal-mode 403: 'role' unless given; null for a 1.0 refusal (editing someone else's comment). */
  reason?: 'role' | 'other_space' | null;
}

/** `c(who, name, send, team, personal, reason?)`: the shorthand the case tables use. */
export function c(
  who: Who,
  name: string,
  send: Case['send'],
  team: number,
  personal: number,
  reason?: Case['reason'],
): Case {
  return { name, who, send, team, personal, ...(reason === undefined ? {} : { reason }) };
}

/** `details.reason` of an error body, if it has one. */
function reasonOf(body: unknown): unknown {
  return (body as Partial<ErrorJson> | null)?.error?.details?.reason;
}

/**
 * Sends the case as its person and expects the status for the mode. A 404 must equal (sameAnswer) the same `send` on
 * UNKNOWN_IDS; a personal 403 carries `reason`; a team 403 carries no details.reason (the 1.0 body).
 */
export async function expectCase(
  ctx: TestContext,
  fx: SpacesFixture,
  mode: Visibility,
  testCase: Case,
): Promise<void> {
  const { who, name, send } = testCase;
  const api = spacesClient(ctx, fx.people[who].cookie);
  const expected = mode === 'team' ? testCase.team : testCase.personal;
  const label = `${who}: ${name}, in ${mode} mode`;
  const r = await send(api, fx.ids, fx.people);
  expect(r.status, `${label}, answered ${JSON.stringify(r.body)}`).toBe(expected);
  if (expected === 404) sameAnswer(r, await send(api, UNKNOWN_IDS, fx.people));
  if (expected === 403) {
    const given = testCase.reason;
    const reason = mode === 'team' ? undefined : given === undefined ? 'role' : given;
    expect(reasonOf(r.body), `${label}: details.reason`).toBe(reason ?? undefined);
  }
}

/** An HTML page's request id, the one part that differs between two equal answers. */
const REQUEST_ID = /<code>[^<]*<\/code>/g;

/** Expects the same status and body; HTML bodies compared without the request id <code>. */
export function sameAnswer(
  actual: { status: number; body: unknown },
  missing: { status: number; body: unknown },
): void {
  const comparable = (a: { status: number; body: unknown }) => ({
    status: a.status,
    body: typeof a.body === 'string' ? a.body.replace(REQUEST_ID, '<code></code>') : a.body,
  });
  expect(comparable(actual), 'the answer differs from the one for an unknown id').toEqual(
    comparable(missing),
  );
}
