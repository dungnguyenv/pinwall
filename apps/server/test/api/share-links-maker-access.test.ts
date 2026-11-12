import { randomUUID } from 'node:crypto';
import { ShareInfo } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { recheckUser } from '../../src/auth/oidc/recheck.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { signInOidcUser } from '../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp, type TestIdpAccount } from '../helpers/oidc-idp.ts';
import { publishFiles } from '../helpers/publish.ts';
import type { ErrorJson } from '../helpers/rest.ts';
import { sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 12);
const H = 3_600_000;
const PW = 'Mật khẩu 1';

let idp: TestIdp;
let noRefresh: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
  noRefresh = await startTestIdp({ refreshTokens: false });
});
afterAll(async () => {
  await idp?.close();
  await noRefresh?.close();
});

describe.each(dialects)("share links follow their maker's current access on %s", (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let artifactId: string;

  afterEach(() => ctx?.close());

  /** A context signed in to `provider`, with one artifact the owner published. */
  async function start(provider: TestIdp = idp) {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env: provider.env() });
    const owner = await createSignedInUser(ctx, { name: 'Ada' });
    artifactId = (await publishFiles(ctx, owner.user, { 'index.html': '<p>một</p>' })).artifact.id;
    return owner;
  }

  function account(provider: TestIdp = idp): TestIdpAccount {
    const a: TestIdpAccount = {
      sub: `user-${randomUUID()}`,
      name: 'Minh',
      email: 'minh@example.com',
      email_verified: true,
    };
    provider.addAccount(a);
    return a;
  }

  async function signIn(a: TestIdpAccount, provider: TestIdp = idp): Promise<UserRow> {
    return (await signInOidcUser(ctx, provider, a)).user;
  }

  /** A link `maker` made, with a password, open to comments, and unlocked in this browser. */
  async function link(maker: UserRow) {
    const { token } = await createShareLink(ctx.deps, maker, artifactId, {
      versionId: null,
      password: PW,
      expiresAt: null,
      allowComments: true,
    });
    const unlocked = await ctx.request(
      `/api/v1/share/${token}/unlock`,
      apiInit(ctx, { method: 'POST', body: { password: PW } }),
    );
    expect(unlocked.status).toBe(204);
    const cookie = unlocked.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    return { token, cookie };
  }

  type Link = Awaited<ReturnType<typeof link>>;

  const info = (l: Link) =>
    ctx.request(`/api/v1/share/${l.token}`, apiInit(ctx, { cookie: l.cookie }));

  /** The grant the share viewer gets, opened through the API. */
  async function grantOf(l: Link): Promise<{ token: string; expiresAt: number }> {
    const r = await info(l);
    expect(r.status).toBe(200);
    const { content } = ShareInfo.parse(await r.json());
    const token = /\/c\/([^/]+)\//.exec(content.url)?.[1] ?? '';
    return { token, expiresAt: content.expires_at };
  }

  /**
   * How each way a guest uses the link answers. An unlock that works renews the cookie the rest
   * send, as the share viewer's would be.
   */
  async function answers(l: Link): Promise<number[]> {
    const unlock = await ctx.request(
      `/api/v1/share/${l.token}/unlock`,
      apiInit(ctx, { method: 'POST', body: { password: PW } }),
    );
    if (unlock.status === 204) l.cookie = unlock.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const comment = await ctx.request(
      `/api/v1/share/${l.token}/comments`,
      apiInit(ctx, {
        method: 'POST',
        cookie: l.cookie,
        body: { guest_name: 'Lan', body: 'Còn xem được?', anchor: sampleAnchor() },
      }),
    );
    const list = await ctx.request(
      `/api/v1/share/${l.token}/comments`,
      apiInit(ctx, { cookie: l.cookie }),
    );
    const page = await ctx.request(`/s/${l.token}`, { headers: { cookie: l.cookie } });
    const original = await ctx.request(`/s/${l.token}/original`, {
      headers: { cookie: l.cookie },
    });
    const events = await ctx.request(`/api/v1/share/${l.token}/events`, {
      method: 'HEAD',
      headers: { cookie: l.cookie },
    });
    return [
      (await info(l)).status,
      unlock.status,
      comment.status,
      list.status,
      page.status,
      original.status,
      events.status,
    ];
  }

  // An open link with comments hands `/s/<token>` on to the web app, which tests do not serve.
  const OPEN = [200, 204, 201, 200, 404, 302, 200];
  const REFUSED = [410, 410, 410, 410, 410, 410, 410];

  /** The refusal is word for word the one a revoked link gives. */
  async function expectAnsweredAsRevoked(l: Link) {
    const r = await info(l);
    expect(r.status).toBe(410);
    expect(((await r.json()) as ErrorJson).error).toEqual({
      code: 'gone',
      message: t('share.gone.message'),
      details: { reason: 'revoked' },
    });
    expect(await answers(l)).toEqual(REFUSED);
  }

  test('a maker the IdP refuses (as when deleted there) has their links refused until they sign in again', async () => {
    await start();
    const a = account();
    const maker = await signIn(a);
    const l = await link(maker);
    expect(await answers(l)).toEqual(OPEN);

    // Due for a check: the link still opens until the check is made, or the 24-hour bound passes.
    clock.advance(12 * H);
    expect((await info(l)).status).toBe(200);
    idp.disable(a.sub);
    expect((await recheckUser(ctx.deps, maker.id)).outcome).toBe('sign_in_required');
    await expectAnsweredAsRevoked(l);
    // Suspended, not revoked: the link row is left as it was.
    const row = await ctx.deps.db.db
      .selectFrom('share_links')
      .select('revoked_at')
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeNull();

    // Back at the IdP, signed in and admitted: the link opens again.
    idp.enable(a.sub);
    clock.advance(H);
    await signIn(a);
    expect(await answers(l)).toEqual(OPEN);
  });

  test('without refresh tokens, links close when the re-check bound passes', async () => {
    await start(noRefresh);
    const a = account(noRefresh);
    const maker = await signIn(a, noRefresh);
    const l = await link(maker);
    clock.advance(12 * H - 1);
    expect((await info(l)).status).toBe(200);
    clock.advance(1);
    await expectAnsweredAsRevoked(l);

    await signIn(a, noRefresh);
    expect(await answers(l)).toEqual(OPEN);
  });

  test('a member whose checks succeed, and the owner, are unaffected by time', async () => {
    const owner = await start();
    const a = account();
    const maker = await signIn(a);
    const theirs = await link(maker);
    const mine = await link(owner.user);
    for (let hours = 0; hours < 48; hours += 12) {
      clock.advance(12 * H);
      expect((await recheckUser(ctx.deps, maker.id)).outcome).toBe('ok');
      expect(await answers(theirs)).toEqual(OPEN);
      expect(await answers(mine)).toEqual(OPEN);
    }
    // Without a successful check for 24 hours, a member's links close; the owner's never do.
    clock.advance(24 * H);
    expect(await answers(theirs)).toEqual(REFUSED);
    expect(await answers(mine)).toEqual(OPEN);
  });

  test("a disabled owner's links are refused", async () => {
    const owner = await start();
    const mine = await link(owner.user);
    await ctx.deps.db.db
      .updateTable('users')
      .set({ disabled_at: clock.now() })
      .where('id', '=', owner.user.id)
      .execute();
    await expectAnsweredAsRevoked(mine);
  });

  test("a grant a link made never outlives its maker's access deadline at the time", async () => {
    await start(noRefresh);
    const maker = await signIn(account(noRefresh), noRefresh);
    const l = await link(maker);
    // The maker's access is current until 12 hours after their sign-in; the preview TTL is 12
    // hours from now. The grant ends at the first.
    clock.advance(H);
    const grant = await grantOf(l);
    expect(grant.expiresAt).toBe(T + 12 * H);
    expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(200);
    clock.advance(11 * H - 1);
    expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(200);
    clock.advance(1);
    expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(410);
  });

  test('a grant made before a failed check lasts at most the preview TTL', async () => {
    await start();
    const a = account();
    const maker = await signIn(a);
    const l = await link(maker);
    clock.advance(11 * H);
    const grant = await grantOf(l);
    // With a refresh token the maker's access runs to 24 hours after the check: the TTL ends first.
    expect(grant.expiresAt).toBe(clock.now() + ctx.deps.config.ttl.previewMs);
    clock.advance(H);
    idp.disable(a.sub);
    expect((await recheckUser(ctx.deps, maker.id)).outcome).toBe('sign_in_required');
    expect((await info(l)).status).toBe(410);
    // The link is suspended; what it already handed out ends with its own expiry.
    expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(200);
    clock.advance(grant.expiresAt - clock.now());
    expect((await fetchContent(ctx, grant.token, 'index.html')).status).toBe(410);
  });
});
