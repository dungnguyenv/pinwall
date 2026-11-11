import { ShareInfo } from '@pinwall/shared';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { contentUrl } from '../../src/content/grants.ts';
import type { UserRow } from '../../src/db/schema.ts';
import {
  resolveShare,
  SHARE_RATES,
  type ShareState,
  shareGrant,
} from '../../src/domain/share-access.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import type { ErrorJson } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);
const PW = 'Mật khẩu 1';

interface LinkOptions {
  versionId: string | null;
  password: string | null;
  expiresAt: number | null;
  allowComments: boolean;
}

describe.each(dialects)('the share viewer API on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };
  let artifactId: string;

  /** A context with one artifact of two versions, published by `member`. */
  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    const first = await publishFiles(ctx, member.user, { 'index.html': '<p>một</p>' });
    clock.advance(1000);
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>hai</p>' },
      { kind: 'new_version', artifactId: first.artifact.id, expectedVersionId: first.version.id },
    );
    artifactId = first.artifact.id;
    clock.advance(1000);
  }

  beforeEach(() => start());
  afterEach(() => ctx.close());

  async function share(o: Partial<LinkOptions> = {}) {
    const { row, token } = await createShareLink(ctx.deps, member.user, artifactId, {
      versionId: null,
      password: PW,
      expiresAt: null,
      allowComments: false,
      ...o,
    });
    return { linkId: row.id, token };
  }

  const unlock = (token: string, pw: string, o: Parameters<typeof apiInit>[1] = {}) =>
    ctx.request(
      `/api/v1/share/${token}/unlock`,
      apiInit(ctx, { method: 'POST', body: { password: pw }, ...o }),
    );

  const info = (token: string, cookie?: string) =>
    ctx.request(`/api/v1/share/${token}`, apiInit(ctx, cookie === undefined ? {} : { cookie }));

  /** `name=value` of the first cookie `r` sets. */
  function cookieOf(r: Response): string {
    const [first = ''] = r.headers.getSetCookie();
    return first.split(';')[0] ?? '';
  }

  const grantsOf = (linkId: string) =>
    ctx.deps.db.db
      .selectFrom('content_grants')
      .selectAll()
      .where('share_link_id', '=', linkId)
      .orderBy('created_at')
      .execute();

  async function errorOf(r: Response) {
    return { status: r.status, ...((await r.json()) as ErrorJson).error };
  }

  test('share info is locked until the password is given', async () => {
    const { linkId, token } = await share();
    const r = await info(token);
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: t('share.passwordRequired'),
        details: { password_required: true },
      },
    });
    expect(await grantsOf(linkId)).toEqual([]);
  });

  test('unlock sets two path-scoped cookies that open the link', async () => {
    const { linkId, token } = await share();
    const r = await unlock(token, PW);
    expect(r.status).toBe(204);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const sc = r.headers.getSetCookie();
    expect(sc).toHaveLength(2);
    expect(sc[0]).toMatch(/^pinwall_share=v1\.\d+\.[A-Za-z0-9_-]{43};/);
    expect(sc.map((s) => /Path=([^;]+)/.exec(s)?.[1]).sort()).toEqual([
      `/api/v1/share/${token}`,
      `/s/${token}`,
    ]);
    expect(sc[1]?.split(';')[0]).toBe(sc[0]?.split(';')[0]);
    for (const s of sc) {
      for (const p of ['HttpOnly', 'SameSite=Lax', 'Max-Age=86400']) expect(s).toContain(p);
      expect(s).not.toContain('Secure');
    }
    expect(cookieOf(r)).toBe(
      `pinwall_share=v1.${clock.now() + 86_400_000}.${cookieOf(r).slice(-43)}`,
    );

    const cookie = cookieOf(r);
    const opened = await info(token, cookie);
    expect(opened.status).toBe(200);
    expect(opened.headers.get('cache-control')).toBe('no-store');
    expect(ShareInfo.parse(await opened.json()).content.mode).toBe('raw');

    clock.advance(1000);
    const page = await ctx.request(`/s/${token}`, { headers: { cookie } });
    expect(page.status).toBe(302);
    const grants = await grantsOf(linkId);
    expect(grants).toHaveLength(2);
    expect(grants[1]?.mode).toBe('raw');
    expect(page.headers.get('location')).toBe(contentUrl(ctx.deps.config, grants[1]?.token ?? ''));
  });

  test('unlock cookies are Secure, __Secure- and capped by the link expiry on https', async () => {
    await ctx.close();
    await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    const { token } = await share({ expiresAt: clock.now() + 7_200_000 });
    const r = await unlock(token, PW);
    expect(r.status).toBe(204);
    const sc = r.headers.getSetCookie();
    expect(sc).toHaveLength(2);
    for (const s of sc) {
      expect(s).toMatch(/^__Secure-pinwall_share=v1\.\d+\.[A-Za-z0-9_-]{43};/);
      for (const p of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=7200'])
        expect(s).toContain(p);
    }
    expect((await info(token, cookieOf(r))).status).toBe(200);
    // The http name is not read on https.
    const plain = cookieOf(r).replace(/^__Secure-/, '');
    expect((await info(token, plain)).status).toBe(401);
  });

  test('an unlock lapses after 24 hours and opens only its own link', async () => {
    const a = await share();
    const b = await share();
    const cookieA = cookieOf(await unlock(a.token, PW));
    const cookieB = cookieOf(await unlock(b.token, PW));
    expect(cookieB).not.toBe(cookieA);
    expect((await info(a.token, cookieA)).status).toBe(200);
    expect((await info(a.token, cookieB)).status).toBe(401);

    // A value changed in any part does not open the link.
    const [name, value = ''] = cookieA.split('=');
    const [version, expiresAt, mac = ''] = value.split('.');
    const later = `${name}=${version}.${Number(expiresAt) + 1}.${mac}`;
    expect((await info(a.token, later)).status).toBe(401);
    const flipped = `${name}=${version}.${expiresAt}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
    expect((await info(a.token, flipped)).status).toBe(401);
    expect((await info(a.token, `${name}=garbage`)).status).toBe(401);

    clock.advance(86_399_999);
    expect((await info(a.token, cookieA)).status).toBe(200);
    clock.advance(2);
    expect((await info(a.token, cookieA)).status).toBe(401);
    // The page is the password form again (the SPA, not built for this suite), not content.
    const page = await ctx.request(`/s/${a.token}`, { headers: { cookie: cookieA } });
    expect(page.status).toBe(404);
    expect(page.headers.get('location')).toBeNull();
    expect(await grantsOf(a.linkId)).toHaveLength(2);
  });

  test('a password typed in another Unicode form unlocks', async () => {
    const { token } = await share({ password: PW.normalize('NFC') });
    const r = await unlock(token, PW.normalize('NFD'));
    expect(r.status).toBe(204);
    expect((await info(token, cookieOf(r))).status).toBe(200);
  });

  test('a link without a password unlocks with nothing to set', async () => {
    const { token } = await share({ password: null });
    const r = await unlock(token, 'anything');
    expect(r.status).toBe(204);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect((await info(token)).status).toBe(200);
  });

  test('a wrong password is refused and unlock is rate limited', async () => {
    const { token } = await share();
    const other = await share();
    expect(await errorOf(await unlock(token, 'wrong password'))).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
      message: t('auth.wrongPassword'),
    });
    for (let i = 1; i < 10; i++) expect((await unlock(token, `wrong ${i}`)).status).toBe(401);
    const limited = await unlock(token, 'wrong again');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('900');
    expect((await unlock(token, PW)).status).toBe(429);
    // The limit is per link: another link still unlocks from the same address.
    expect((await unlock(other.token, PW)).status).toBe(204);

    // Every address together gets 100 tries of one link an hour.
    clock.advance(900_000);
    const { name, limit, windowMs } = SHARE_RATES.unlockLink;
    for (let i = 0; i < 100; i++) {
      await ctx.deps.rateLimiter.consume(`${name}:${other.linkId}`, limit, windowMs);
    }
    expect((await unlock(other.token, PW)).status).toBe(429);
    expect((await unlock(token, PW)).status).toBe(204);
  });

  test('unlocking a revoked, expired or unknown link answers as opening it does', async () => {
    const revoked = await share();
    const expiring = await share({ expiresAt: clock.now() + 1000 });
    await revokeShareLink(ctx.deps, member.user, revoked.linkId);
    clock.advance(1000);
    expect(await errorOf(await unlock(revoked.token, PW))).toMatchObject({
      status: 410,
      code: 'gone',
      message: t('share.gone.message'),
      details: { reason: 'revoked' },
    });
    expect(await errorOf(await info(expiring.token))).toMatchObject({
      status: 410,
      message: t('share.expired.message'),
      details: { reason: 'expired' },
    });
    expect(await errorOf(await unlock('x'.repeat(43), PW))).toMatchObject({
      status: 404,
      code: 'not_found',
      message: t('share.notFound.message'),
    });
  });

  test('share info gives a review grant when comments are allowed, raw otherwise', async () => {
    const discussed = await share({ password: null, allowComments: true });
    const r = await info(discussed.token);
    expect(r.status).toBe(200);
    const body = ShareInfo.parse(await r.json());
    const [grant] = await grantsOf(discussed.linkId);
    expect(grant).toMatchObject({ mode: 'review', user_id: null });
    expect(body).toEqual({
      artifact_name: 'index',
      kind: 'html',
      version_number: 2,
      follows_current: true,
      allow_comments: true,
      expires_at: null,
      content: {
        url: contentUrl(ctx.deps.config, grant?.token ?? ''),
        mode: 'review',
        expires_at: clock.now() + ctx.deps.config.ttl.previewMs,
        isolation: 'single-domain',
      },
    });

    const v1 = await ctx.deps.db.db
      .selectFrom('versions')
      .select('id')
      .where('artifact_id', '=', artifactId)
      .where('number', '=', 1)
      .executeTakeFirstOrThrow();
    const expiresAt = clock.now() + 3_600_000;
    const plain = await share({ password: null, versionId: v1.id, expiresAt });
    const raw = ShareInfo.parse(await (await info(plain.token)).json());
    expect(raw).toMatchObject({
      version_number: 1,
      follows_current: false,
      allow_comments: false,
      expires_at: expiresAt,
      content: { mode: 'raw', expires_at: expiresAt },
    });
  });

  test('cross-origin unlock is refused', async () => {
    const { token } = await share();
    const r = await unlock(token, PW, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  test('a grant is never made from a link revoked while it is made', async () => {
    const { linkId, token } = await share({ password: null });
    // The link was open when the viewer resolved it ...
    const state: ShareState = await resolveShare(ctx.deps, token, undefined);
    let outcome: Promise<unknown> | undefined;
    // ... and a revoke has marked it, without committing yet, when the grant is made.
    await ctx.deps.db.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('share_links')
        .set({ revoked_at: clock.now() })
        .where('id', '=', linkId)
        .execute();
      await trx.deleteFrom('content_grants').where('share_link_id', '=', linkId).execute();
      outcome = shareGrant(ctx.deps, state, 'raw').then(
        () => 'granted',
        (err: unknown) => err,
      );
      if (dialect === 'postgres') await untilWaitingOnALock(outcome);
    });
    expect(await outcome).toMatchObject({ status: 410, details: { reason: 'revoked' } });
    expect(await grantsOf(linkId)).toEqual([]);
  });

  /**
   * Resolves once another connection of this test database waits on a row lock, or once
   * `settled` has (the grant did not wait, which the test then reports).
   */
  async function untilWaitingOnALock(settled: Promise<unknown>): Promise<void> {
    let done = false;
    void settled.then(() => {
      done = true;
    });
    const deadline = Date.now() + 5000;
    while (!done && Date.now() < deadline) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(ctx.deps.db.db);
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
