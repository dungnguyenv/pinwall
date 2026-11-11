import { randomUUID } from 'node:crypto';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CommentThreadList, LiveEvent, PublishResult } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ARTIFACT_TOPIC } from '../../src/domain/search.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import type {
  CreatePublishSessionOut,
  GetArtifactOut,
  ListArtifactsOut,
  ListCommentsOut,
  ProjectDetailOut,
  PublishInlineOut,
  ReplyToCommentOut,
  ResolveCommentOut,
  WhoamiOut,
} from '../../src/mcp/schemas.ts';
import { makeTar } from '../helpers/archives.ts';
import { apiInit, createSignedInUser, setupOwner } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import {
  approveInBrowser,
  connectMcp,
  inProcessFetch,
  mcpTransport,
  TestOAuthProvider,
  toolText,
} from '../helpers/mcp.ts';
import { signInOidcUser } from '../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp } from '../helpers/oidc-idp.ts';
import { postThread, sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 10);
const ORIGIN = 'http://localhost:8080';
const ACCESS_TOKEN_MS = 3_600_000;
/** How long Pinwall acts on an IdP user's last good check while it cannot ask the IdP again. */
const IDP_STALENESS_MS = 86_400_000;
/** After an IdP check fails, the next one waits this long. */
const IDP_RETRY_BACKOFF_MS = 60_000;
/** Where the agent's browser comes back to: a loopback listener, as Claude Code registers. */
const REDIRECT_URL = 'http://127.0.0.1:33418/callback';
/** One test walks the whole flow (dozens of requests, one password hash): room on a loaded machine. */
const FLOW_TIMEOUT_MS = 60_000;

/** What each tool's `structuredContent` holds. */
interface Outputs {
  whoami: WhoamiOut;
  get_project: ProjectDetailOut;
  list_artifacts: ListArtifactsOut;
  get_artifact: GetArtifactOut;
  create_publish_session: CreatePublishSessionOut;
  publish_inline: PublishInlineOut;
  list_comments: ListCommentsOut;
  reply_to_comment: ReplyToCommentOut;
  resolve_comment: ResolveCommentOut;
}
type Ok<N extends keyof Outputs> = CallToolResult & { structuredContent: Outputs[N] };

/** A tool call that must succeed. */
async function ok<N extends keyof Outputs>(
  client: Client,
  name: N,
  args: Record<string, unknown> = {},
): Promise<Ok<N>> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(r.isError, `${name}: ${toolText(r)}`).toBeFalsy();
  return r as Ok<N>;
}

/**
 * The agent's `fetch`: in-process, noting each call to `/mcp` and to the OAuth endpoints as
 * `METHOD path status`, with the grant type and the error code for the token endpoint.
 * Discovery reads are left out, since when the SDK repeats them is its own business.
 */
function recordedFetch(ctx: TestContext): { fetch: FetchLike; calls: string[] } {
  const base = inProcessFetch(ctx);
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const res = await base(url, init);
    const { pathname } = new URL(url);
    if (pathname.startsWith('/.well-known/')) return res;
    const parts = [(init?.method ?? 'GET').toUpperCase(), pathname];
    if (pathname === '/oauth/token') {
      parts.push(new URLSearchParams(String(init?.body)).get('grant_type') ?? '-');
    }
    parts.push(String(res.status));
    if (pathname === '/oauth/token' && !res.ok) {
      parts.push(((await res.clone().json()) as { error: string }).error);
    }
    calls.push(parts.join(' '));
    return res;
  };
  return { fetch, calls };
}

/** A gzipped tar of a folder, as `tar -czf - -C ./site .` makes it. */
const siteTar = (heading: string) =>
  makeTar(
    [
      {
        name: 'index.html',
        body: `<!doctype html><link rel="stylesheet" href="css/a.css">${heading}`,
      },
      { name: 'css/a.css', body: 'h1 { color: teal; }' },
    ],
    { gzip: true },
  );

let idp: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
});
afterAll(() => idp?.close());

describe.each(dialects)('an agent over MCP on %s', (dialect) => {
  let ctx: TestContext | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    idp.setReachable(true);
    await client?.close();
    await ctx?.close();
    client = undefined;
    ctx = undefined;
  });

  test(
    'signs in through the browser, publishes, refreshes, fixes a pinned comment and loses access on Revoke now',
    async () => {
      const clock = new FixedClock(T);
      const app = await createTestContext({ dialect, clock });
      ctx = app;
      const owner = await setupOwner(app);
      const traffic = recordedFetch(app);
      const provider = new TestOAuthProvider({
        redirectUrl: REDIRECT_URL,
        clientName: 'Claude Code',
      });

      const versionRow = (id: string) =>
        app.deps.db.db
          .selectFrom('versions')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
      /** The agent's shell running the command `create_publish_session` returned. */
      const upload = async (url: string, body: Buffer): Promise<PublishResult> => {
        const r = await app.request(url, { method: 'POST', body });
        expect(r.status, await r.clone().text()).toBe(201);
        return PublishResult.parse(await r.json());
      };

      // Part A — acceptance 2: sign in through the browser, then publish a folder.
      // 1. The first connect has no token: the SDK registers and starts the authorization.
      const first = mcpTransport(app, { authProvider: provider, fetch: traffic.fetch });
      await expect(
        new Client({ name: 'pinwall-agent-flow', version: '0.0.0' }).connect(first),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(traffic.calls).toEqual(['POST /mcp 401', 'POST /oauth/register 201']);
      const registered = await provider.clientInformation();
      expect(registered?.client_id).toMatch(/^cli_/);

      // 2. The browser is sent to Pinwall's authorize endpoint with PKCE and the resource.
      const authorizationUrl = provider.authorizationUrl;
      if (authorizationUrl === null) throw new Error('the SDK never sent the browser anywhere');
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        `${ORIGIN}/oauth/authorize`,
      );
      expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
        response_type: 'code',
        client_id: registered?.client_id,
        redirect_uri: REDIRECT_URL,
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: 'S256',
        resource: `${ORIGIN}/mcp`,
        scope: 'pinwall',
        state: 'flow-state',
      });

      // 3. The person allows it; the code comes back to the agent, which redeems it.
      const code = await approveInBrowser(app, authorizationUrl, owner.cookie);
      traffic.calls.length = 0;
      await first.finishAuth(code);
      expect(traffic.calls).toEqual(['POST /oauth/token authorization_code 200']);
      const issued = await provider.tokens();
      expect(issued).toMatchObject({
        token_type: expect.stringMatching(/^bearer$/i),
        access_token: expect.stringMatching(/^pwa_/),
        refresh_token: expect.stringMatching(/^pwr_/),
        scope: 'pinwall',
      });

      client = await connectMcp(app, { authProvider: provider, fetch: traffic.fetch });
      const me = await ok(client, 'whoami');
      expect(me.structuredContent).toMatchObject({
        user: { id: owner.me.id, role: 'admin' },
        via: 'oauth',
        pinwall_url: ORIGIN,
      });

      // 4. As the instructions say: read the project, then ask for an upload URL.
      const project = await ok(client, 'get_project');
      expect(project.structuredContent.project).toMatchObject({ is_default: true });
      const session = await ok(client, 'create_publish_session', { directory: './site' });
      expect(session.structuredContent.target).toEqual({ kind: 'new_artifact', artifact_id: null });
      expect(session.structuredContent.commands.archive).toContain('-C ./site .');

      // 5. The folder goes up from the agent's shell.
      const v1 = await upload(
        session.structuredContent.upload_url,
        await siteTar('<h1>Hello</h1>'),
      );
      const artifactId = v1.artifact_id;
      expect(v1).toMatchObject({ version_number: 1, file_count: 2, entry_path: 'index.html' });
      expect(v1.review_url).toBe(`${ORIGIN}/a/${artifactId}`);
      expect(await versionRow(v1.version_id)).toMatchObject({
        number: 1,
        source: 'mcp',
        created_by: owner.me.id,
      });

      // Part B — the access token expires; the SDK refreshes on the 401 and goes on.
      const before = await provider.tokens();
      if (!before?.refresh_token) throw new Error('no refresh token was issued');
      traffic.calls.length = 0;
      clock.advance(ACCESS_TOKEN_MS + 1);
      const listed = await ok(client, 'list_artifacts');
      expect(listed.structuredContent.artifacts.map((a) => a.id)).toEqual([artifactId]);
      expect(traffic.calls).toEqual([
        'POST /mcp 401',
        'POST /oauth/token refresh_token 200',
        'POST /mcp 200',
      ]);
      const after = await provider.tokens();
      expect(after?.refresh_token).toMatch(/^pwr_/);
      expect(after?.refresh_token).not.toBe(before.refresh_token);
      expect(after?.access_token).not.toBe(before.access_token);
      const spent = await app.deps.db.db
        .selectFrom('oauth_tokens')
        .selectAll()
        .where('token_hash', '=', hashSecret(before.refresh_token))
        .executeTakeFirstOrThrow();
      expect(spent).toMatchObject({ kind: 'refresh', used_at: clock.now() });

      // Part C — acceptance 3a: an agent without a shell publishes inline.
      const inline = await ok(client, 'publish_inline', {
        files: [{ path: 'index.html', content: '<!doctype html><h1>Notes</h1>' }],
      });
      const notes = inline.structuredContent;
      expect(notes.artifact_id).not.toBe(artifactId);
      expect(notes.review_url).toBe(`${ORIGIN}/a/${notes.artifact_id}`);
      expect(toolText(inline).split('\n')[0]).toBe(`Review link: ${notes.review_url}`);
      expect(await versionRow(notes.version_id)).toMatchObject({
        number: 1,
        source: 'inline',
        created_by: owner.me.id,
      });

      // Part D — acceptance 4, agent side: the fix loop.
      // 1. A member pins a thread on v1 in the browser; their review tab listens.
      const member = await createSignedInUser(app, { kind: 'oidc', name: 'Bình' });
      const pinned = await postThread(app, member.cookie, artifactId, {
        body: 'Say hello in Vietnamese',
        anchor: sampleAnchor({
          page: '',
          quote: { exact: 'Hello', prefix: '', suffix: '' },
          dom: { path: 'h1' },
        }),
        versionId: v1.version_id,
      });
      const seen: unknown[] = [];
      app.deps.events.subscribe(ARTIFACT_TOPIC(artifactId), (e) => seen.push(e));

      // 2. The agent reads the thread, publishes the fix on top of v1, replies and resolves.
      const comments = await ok(client, 'list_comments', { artifact_id: artifactId });
      expect(comments.structuredContent.threads).toHaveLength(1);
      expect(comments.structuredContent.threads[0]).toMatchObject({
        id: pinned.id,
        status: 'open',
        version: { id: v1.version_id, number: 1 },
        anchor: { page: '', kind: 'text', quote: { exact: 'Hello' }, selector: 'h1' },
        author: 'Bình',
        body: 'Say hello in Vietnamese',
      });
      expect(toolText(comments)).toContain(`[${pinned.id}] v1`);
      expect(toolText(comments)).toContain('"Hello"');

      const got = await ok(client, 'get_artifact', { artifact_id: artifactId });
      const current = got.structuredContent.artifact.current_version;
      expect(current).toEqual({ id: v1.version_id, number: 1 });
      const fix = await ok(client, 'create_publish_session', {
        artifact_id: artifactId,
        expected_version_id: current?.id,
        directory: './site',
      });
      expect(fix.structuredContent.target).toEqual({
        kind: 'new_version',
        artifact_id: artifactId,
      });
      const v2 = await upload(fix.structuredContent.upload_url, await siteTar('<h1>Xin chào</h1>'));
      expect(v2).toMatchObject({ artifact_id: artifactId, version_number: 2 });
      expect(await versionRow(v2.version_id)).toMatchObject({
        source: 'mcp',
        created_by: owner.me.id,
        parent_version_id: v1.version_id,
      });

      const reply = await ok(client, 'reply_to_comment', {
        comment_id: pinned.id,
        body: 'Done in v2: the heading now reads "Xin chào".',
      });
      expect(reply.structuredContent.comment.thread_id).toBe(pinned.id);
      const resolved = await ok(client, 'resolve_comment', {
        comment_id: pinned.id,
        version_id: v2.version_id,
      });
      expect(resolved.structuredContent.thread).toMatchObject({
        id: pinned.id,
        status: 'resolved',
        resolved_in_version: { id: v2.version_id, number: 2 },
      });

      // 3. The reviewer sees it resolved by v2, still pinned where they put it.
      const r = await app.request(
        `${ORIGIN}/api/v1/artifacts/${artifactId}/comments?status=resolved`,
        apiInit(app, { cookie: member.cookie }),
      );
      expect(r.status).toBe(200);
      const { items } = CommentThreadList.parse(await r.json());
      expect(items.map((th) => th.id)).toEqual([pinned.id]);
      expect(items[0]).toMatchObject({
        status: 'resolved',
        version: { id: v1.version_id, number: 1 },
        resolved_in_version: { id: v2.version_id, number: 2 },
        resolved_by: { user_id: owner.me.id },
        replies: [{ body: 'Done in v2: the heading now reads "Xin chào".' }],
      });
      expect(items[0]?.anchor).toEqual(pinned.anchor);

      // 4. The open review tab heard of v2 before the thread closed: it switches on that.
      const events = seen.map((e) => LiveEvent.parse(e));
      expect(events.map((e) => e.type)).toEqual([
        'version.published',
        'comment.created',
        'comment.resolved',
      ]);
      expect(events[0]).toMatchObject({ version_id: v2.version_id, number: 2 });
      expect(events[2]).toMatchObject({ thread: { id: pinned.id, status: 'resolved' } });

      // Part E — 3b for agents: Revoke now ends the connection.
      provider.authorizationUrl = null;
      const revoked = await app.request(
        `${ORIGIN}/api/v1/admin/users/${owner.me.id}/revoke`,
        apiInit(app, { method: 'POST', cookie: owner.cookie }),
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ oauth_grants: 1 });

      traffic.calls.length = 0;
      await expect(
        client.callTool({ name: 'list_artifacts', arguments: {} }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(traffic.calls).toEqual([
        'POST /mcp 401',
        'POST /oauth/token refresh_token 400 invalid_grant',
      ]);
      expect(await provider.tokens()).toBeUndefined();
      // The SDK starts a new sign-in with the client it already has. (The cast undoes the
      // narrowing to null from the reset above, which the SDK's callback changed since.)
      const again = provider.authorizationUrl as URL | null;
      expect(again).not.toBeNull();
      expect(again?.searchParams.get('client_id')).toBe(registered?.client_id);
    },
    FLOW_TIMEOUT_MS,
  );
  test(
    'keeps its tokens through an IdP outage and works again without a browser once the IdP is back',
    async () => {
      const clock = new FixedClock(T);
      const app = await createTestContext({
        dialect,
        clock,
        env: idp.env({ PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users' }),
      });
      ctx = app;
      const bea = await signInOidcUser(app, idp, {
        sub: `bea-${randomUUID()}`,
        name: 'Bea',
        email: 'bea@example.com',
        email_verified: true,
        groups: ['pinwall-users'],
      });
      const traffic = recordedFetch(app);
      const provider = new TestOAuthProvider({
        redirectUrl: REDIRECT_URL,
        clientName: 'Claude Code',
      });

      // Bea, an IdP member, connects the agent through the browser.
      const first = mcpTransport(app, { authProvider: provider, fetch: traffic.fetch });
      await expect(
        new Client({ name: 'pinwall-agent-flow', version: '0.0.0' }).connect(first),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      const authorizationUrl = provider.authorizationUrl;
      if (authorizationUrl === null) throw new Error('the SDK never sent the browser anywhere');
      await first.finishAuth(await approveInBrowser(app, authorizationUrl, bea.cookie));
      client = await connectMcp(app, { authProvider: provider, fetch: traffic.fetch });
      expect((await ok(client, 'whoami')).structuredContent.user.id).toBe(bea.user.id);

      // The IdP is down for longer than Pinwall acts on its last answer. The refresh is told to
      // try later, so the SDK keeps everything it holds and opens no browser.
      const held = await provider.tokens();
      if (!held?.refresh_token) throw new Error('no refresh token was issued');
      idp.setReachable(false);
      clock.advance(IDP_STALENESS_MS);
      provider.authorizationUrl = null;
      traffic.calls.length = 0;
      await expect(client.callTool({ name: 'whoami', arguments: {} })).rejects.toBeInstanceOf(
        TemporarilyUnavailableError,
      );
      expect(traffic.calls).toEqual([
        'POST /mcp 401',
        'POST /oauth/token refresh_token 503 temporarily_unavailable',
      ]);
      expect(await provider.tokens()).toEqual(held);
      expect(provider.authorizationUrl).toBeNull();
      const kept = await app.deps.db.db
        .selectFrom('oauth_tokens')
        .selectAll()
        .where('token_hash', '=', hashSecret(held.refresh_token))
        .executeTakeFirstOrThrow();
      expect(kept).toMatchObject({ kind: 'refresh', used_at: null });

      // The IdP answers again: the next call refreshes with the same token and goes through.
      idp.setReachable(true);
      clock.advance(IDP_RETRY_BACKOFF_MS + 1);
      traffic.calls.length = 0;
      expect((await ok(client, 'whoami')).structuredContent.user.id).toBe(bea.user.id);
      expect(traffic.calls).toEqual([
        'POST /mcp 401',
        'POST /oauth/token refresh_token 200',
        'POST /mcp 200',
      ]);
      expect(provider.authorizationUrl).toBeNull();
      expect((await provider.tokens())?.refresh_token).not.toBe(held.refresh_token);
    },
    FLOW_TIMEOUT_MS,
  );
});
