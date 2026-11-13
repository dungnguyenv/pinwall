import { InsertQueryNode, PrimitiveValueListNode, ValueNode, ValuesNode } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { idpAccessCurrent, idpAccessDeadline } from '../../src/auth/oidc/gate.ts';
import { revokeAllCredentials } from '../../src/auth/revoke.ts';
import {
  contentBaseUrl,
  contentUrl,
  createGrant,
  purgeExpiredGrants,
  resolveGrant,
} from '../../src/content/grants.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import type { AppDeps } from '../../src/deps.ts';
import { deleteArtifact, deleteVersion } from '../../src/domain/deletion.ts';
import { createShareLink, revokeShareLink } from '../../src/domain/shares.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { newContentToken } from '../../src/lib/ids.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);
const H = 3_600_000;

/** The error `promise` rejects with, as `{ status, message, details }`. */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, message: error.message, details: error.details };
  }
  throw new Error('expected a rejection');
}

describe.each(dialects)('content grants on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let owner: UserRow;
  let version: VersionRow;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    owner = (await createSignedInUser(ctx)).user;
    ({ version } = await publishFiles(ctx, owner, { 'index.html': '<p>hi</p>' }));
  });
  afterEach(() => ctx.close());

  const raw = (o: { user?: UserRow | null; ttlMs?: number } = {}) =>
    createGrant(ctx.deps, { versionId: version.id, mode: 'raw', user: owner, ...o });

  test('a grant lives for PINWALL_PREVIEW_TTL', async () => {
    const grant = await raw();
    expect(grant).toEqual({
      token: expect.stringMatching(/^[0-9a-hjkmnp-tv-z]{32}$/),
      version_id: version.id,
      mode: 'raw',
      share_link_id: null,
      user_id: owner.id,
      created_at: T,
      expires_at: T + 43_200_000,
    });
    const stored = await ctx.deps.db.db
      .selectFrom('content_grants')
      .selectAll()
      .where('token', '=', grant.token)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual(grant);

    clock.set(T + 43_200_000 - 1);
    expect(await resolveGrant(ctx.deps, grant.token)).toEqual({ grant, version });
    clock.set(T + 43_200_000);
    expect(await failure(resolveGrant(ctx.deps, grant.token))).toEqual({
      status: 410,
      message: t('content.expired.message'),
      details: { expired: true },
    });
  });

  test('a grant takes its mode and an explicit lifetime', async () => {
    const review = await createGrant(ctx.deps, {
      versionId: version.id,
      mode: 'review',
      user: null,
      ttlMs: 5_000,
    });
    expect(review.mode).toBe('review');
    expect(review.expires_at).toBe(T + 5_000);
    // Made for nobody signed in (a share link's guest): it belongs to no user.
    expect(review.user_id).toBeNull();
    expect((await resolveGrant(ctx.deps, review.token)).grant.mode).toBe('review');
  });

  test("an OIDC user's grant ends when their IdP access stops being current", async () => {
    const { user } = await createSignedInUser(ctx, { kind: 'oidc' });
    const at = async (o: { checkedHoursAgo: number; refresh: boolean }) => {
      await ctx.deps.db.db
        .updateTable('users')
        .set({
          idp_checked_at: T - o.checkedHoursAgo * H,
          idp_refresh_token: o.refresh ? 'v1.sealed' : null,
        })
        .where('id', '=', user.id)
        .execute();
      return ctx.deps.db.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
    };

    // With a refresh token, access holds 24 h after the last check: 4 h are left, not 12.
    const stale = await at({ checkedHoursAgo: 20, refresh: true });
    expect(idpAccessDeadline(stale, ctx.deps.config)).toBe(T + 4 * H);
    expect((await raw({ user: stale })).expires_at).toBe(T + 4 * H);

    // Without one, it ends when the re-check (12 h) falls due.
    const noRefresh = await at({ checkedHoursAgo: 5, refresh: false });
    expect(idpAccessDeadline(noRefresh, ctx.deps.config)).toBe(T + 7 * H);
    expect((await raw({ user: noRefresh })).expires_at).toBe(T + 7 * H);

    // A fresh check leaves the preview TTL as the shorter bound.
    const fresh = await at({ checkedHoursAgo: 0, refresh: true });
    expect((await raw({ user: fresh })).expires_at).toBe(T + 12 * H);

    // Never checked: no access, so the grant is born expired.
    const unchecked = { ...fresh, idp_checked_at: null };
    expect(idpAccessDeadline(unchecked, ctx.deps.config)).toBe(0);
    const dead = await raw({ user: unchecked });
    expect((await failure(resolveGrant(ctx.deps, dead.token))).status).toBe(410);

    // The owner's access does not depend on the IdP.
    expect(idpAccessDeadline(owner, ctx.deps.config)).toBeNull();
    expect((await raw({ user: owner })).expires_at).toBe(T + 12 * H);
  });

  test('the deadline agrees with idpAccessCurrent', async () => {
    const { user } = await createSignedInUser(ctx, { kind: 'oidc' });
    const cfg = ctx.deps.config;
    for (const u of [
      user,
      { ...user, idp_refresh_token: 'v1.sealed' },
      { ...user, idp_checked_at: null },
      owner,
    ]) {
      const deadline = idpAccessDeadline(u, cfg);
      for (const now of [T, T + 12 * H - 1, T + 12 * H, T + 24 * H - 1, T + 24 * H]) {
        expect(idpAccessCurrent(u, now, cfg)).toBe(deadline === null || now < deadline);
      }
    }
  });

  test('unknown tokens are not found, deleted ones gone', async () => {
    const unknown = 'a'.repeat(32);
    const notFound = { status: 404, message: t('content.notFound.message'), details: undefined };
    expect(await failure(resolveGrant(ctx.deps, unknown))).toEqual(notFound);
    expect(await failure(resolveGrant(ctx.deps, 'not a token'))).toEqual(notFound);
    expect(await failure(resolveGrant(ctx.deps, ''))).toEqual(notFound);

    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'content_grant', key: unknown, expiresAt: T + 1000 }],
      T,
    );
    expect(await failure(resolveGrant(ctx.deps, unknown))).toEqual({
      status: 410,
      message: t('content.gone.message'),
      details: undefined,
    });
    // Once the tombstone expires, the token is merely unknown.
    clock.advance(1000);
    expect((await failure(resolveGrant(ctx.deps, unknown))).status).toBe(404);
  });

  test('a grant serves only while its user has access', async () => {
    const { user: member } = await createSignedInUser(ctx, { kind: 'oidc' });
    const grant = await raw({ user: member });
    const guest = await raw({ user: null });
    const update = (set: { role_override?: 'blocked' | null; disabled_at?: number | null }) =>
      ctx.deps.db.db.updateTable('users').set(set).where('id', '=', member.id).execute();
    const refused = { status: 410, message: t('content.gone.message'), details: undefined };

    await update({ role_override: 'blocked' });
    expect(await failure(resolveGrant(ctx.deps, grant.token))).toEqual(refused);
    expect((await resolveGrant(ctx.deps, guest.token)).grant).toEqual(guest);
    await update({ role_override: null });
    expect((await resolveGrant(ctx.deps, grant.token)).grant).toEqual(grant);
    await update({ disabled_at: T });
    expect(await failure(resolveGrant(ctx.deps, grant.token))).toEqual(refused);
  });

  test("revoking a user's credentials ends their grants at once", async () => {
    const { user: member } = await createSignedInUser(ctx, { kind: 'oidc' });
    const live = await raw({ user: member });
    const review = await createGrant(ctx.deps, {
      versionId: version.id,
      mode: 'review',
      user: member,
    });
    const short = await raw({ user: member, ttlMs: 1_000 });
    const others = await raw({ user: owner });
    const guest = await raw({ user: null });
    clock.advance(1_000);

    const result = await revokeAllCredentials(ctx.deps, member.id);
    expect(result.contentGrants).toBe(3);
    const left = await ctx.deps.db.db.selectFrom('content_grants').select('token').execute();
    expect(left.map((row) => row.token).sort()).toEqual([others.token, guest.token].sort());
    // Revoked links say they are gone, for as long as they would have lived.
    for (const token of [live.token, review.token]) {
      expect(await failure(resolveGrant(ctx.deps, token))).toEqual({
        status: 410,
        message: t('content.gone.message'),
        details: undefined,
      });
    }
    // One that had expired needs no tombstone.
    expect((await failure(resolveGrant(ctx.deps, short.token))).status).toBe(404);
    clock.set(live.expires_at);
    expect((await failure(resolveGrant(ctx.deps, live.token))).status).toBe(404);
    expect((await revokeAllCredentials(ctx.deps, member.id)).contentGrants).toBe(0);
  });

  /**
   * `ctx.deps`, watched: `ended` gets, for each statement that tombstones content grants, their
   * tokens in the order the statement lists them.
   */
  function watchingGrantTombstones(): { deps: AppDeps; ended: string[][] } {
    const ended: string[][] = [];
    const db = ctx.deps.db.db.withPlugin({
      transformQuery: ({ node }) => {
        if (
          InsertQueryNode.is(node) &&
          node.into?.table.identifier.name === 'tombstones' &&
          node.values !== undefined &&
          ValuesNode.is(node.values)
        ) {
          const columns = (node.columns ?? []).map((column) => column.column.name);
          const rows = node.values.values.map((row) => {
            const values = PrimitiveValueListNode.is(row)
              ? row.values
              : row.values.map((value) => (ValueNode.is(value) ? value.value : value));
            return Object.fromEntries(columns.map((column, i) => [column, values[i]]));
          });
          const tokens = rows
            .filter((row) => row.kind === 'content_grant')
            .map((row) => String(row.key));
          if (tokens.length > 0) ended.push(tokens);
        }
        return node;
      },
      transformResult: async ({ result }) => result,
    });
    return { deps: { ...ctx.deps, db: { ...ctx.deps.db, db } }, ended };
  }

  /** Five live grants on `versionId`, made in falling token order, which a scan follows. */
  async function grantsInFallingOrder(
    versionId: string,
    o: { shareLinkId?: string; userId?: string } = {},
  ): Promise<string[]> {
    const tokens = Array.from({ length: 5 }, () => newContentToken())
      .sort()
      .reverse();
    for (const token of tokens) {
      await ctx.deps.db.db
        .insertInto('content_grants')
        .values({
          token,
          version_id: versionId,
          mode: 'review',
          share_link_id: o.shareLinkId ?? null,
          user_id: o.userId ?? null,
          created_at: clock.now(),
          expires_at: clock.now() + H,
        })
        .execute();
    }
    return tokens;
  }

  // Two transactions that end some of the same grants then insert their tombstones in one order,
  // so neither can hold one tombstone while waiting for another that the other holds.
  test('every way of ending grants tombstones them in token order', async () => {
    const { user: member } = await createSignedInUser(ctx, { kind: 'oidc' });
    const artifactId = version.artifact_id;
    const { version: v2 } = await publishFiles(
      ctx,
      owner,
      { 'index.html': '<p>2</p>' },
      { kind: 'new_version', artifactId, expectedVersionId: version.id },
    );
    const { row: link } = await createShareLink(ctx.deps, owner, artifactId, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: true,
    });
    const fromLink = await grantsInFallingOrder(v2.id, { shareLinkId: link.id });
    const forMember = await grantsInFallingOrder(v2.id, { userId: member.id });
    const onV1 = await grantsInFallingOrder(version.id);
    const onV2 = await grantsInFallingOrder(v2.id);
    const { deps, ended } = watchingGrantTombstones();
    const auth = { user: owner, via: 'session' } as const;

    await revokeShareLink(deps, owner, link.id);
    await revokeAllCredentials(deps, member.id);
    await deleteVersion(deps, auth, artifactId, 1);
    await deleteArtifact(deps, auth, artifactId);
    const inTokenOrder = (tokens: string[]) => [...tokens].sort();
    expect(ended).toEqual([fromLink, forMember, onV1, onV2].map(inTokenOrder));
  });

  test('purge removes only expired grants', async () => {
    const short = await raw({ ttlMs: 1_000 });
    const long = await raw();
    clock.advance(999);
    expect(await purgeExpiredGrants(ctx.deps)).toBe(0);
    clock.advance(1);
    expect(await purgeExpiredGrants(ctx.deps)).toBe(1);
    const left = await ctx.deps.db.db.selectFrom('content_grants').select('token').execute();
    expect(left.map((row) => row.token)).toEqual([long.token]);
    expect((await failure(resolveGrant(ctx.deps, short.token))).status).toBe(404);
    expect((await resolveGrant(ctx.deps, long.token)).grant).toEqual(long);
  });
});

describe('content URLs', () => {
  const contexts: TestContext[] = [];
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.close();
  });
  const configFor = async (env: Record<string, string>) => {
    const ctx = await createTestContext({ env });
    contexts.push(ctx);
    return ctx.deps.config;
  };
  const tok = '0123456789abcdefghjkmnpqrstvwxyz';

  test('content URLs per mode', async () => {
    const single = await configFor({});
    expect(contentBaseUrl(single, tok)).toBe(`http://localhost:8080/c/${tok}/`);
    expect(contentUrl(single, tok)).toBe(`http://localhost:8080/c/${tok}/`);
    expect(contentUrl(single, tok, 'a b/é.html')).toBe(
      `http://localhost:8080/c/${tok}/a%20b/%C3%A9.html`,
    );

    const content = await configFor(CONTENT_ENV);
    expect(contentBaseUrl(content, tok)).toBe(`https://${tok}.pw-content.test/`);
    expect(contentUrl(content, tok, 'a b/é.html')).toBe(
      `https://${tok}.pw-content.test/a%20b/%C3%A9.html`,
    );
    expect(contentUrl(content, tok, 'q?#.html')).toBe(
      `https://${tok}.pw-content.test/q%3F%23.html`,
    );

    const withPort = await configFor({
      ...CONTENT_ENV,
      PINWALL_CONTENT_ORIGIN: 'https://pw-content.test:8443',
    });
    expect(contentBaseUrl(withPort, tok)).toBe(`https://${tok}.pw-content.test:8443/`);
  });
});
