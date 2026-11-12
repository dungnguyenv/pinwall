import { ShareInfo, ShareLinkList } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { disableRemovedUser } from '../../src/auth/oidc/recheck.ts';
import { revokeAllCredentials } from '../../src/auth/revoke.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { deleteArtifact } from '../../src/domain/deletion.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects, untilWaitingOnALock } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import type { ErrorJson } from '../helpers/rest.ts';
import { sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 12);
const PW = 'Mật khẩu 1';

type Member = { user: UserRow; cookie: string };

/** One share link, with what a guest holds once they have opened it. */
interface Opened {
  linkId: string;
  token: string;
  /** The unlock cookie, for a link with a password. */
  cookie: string | undefined;
  /** A content grant the share viewer was given. */
  grant: string;
}

describe.each(dialects)('share links whose creator loses access on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  /** The owner: an admin, and the artifact's publisher. */
  let admin: Member;
  /** The member who makes the links and then loses access. */
  let m: Member;
  /** Another member, who keeps access. */
  let o: Member;
  let artifactId: string;
  let v1: VersionRow;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    admin = await createSignedInUser(ctx, { name: 'Ada' });
    m = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });
    o = await createSignedInUser(ctx, { kind: 'oidc', name: 'Oanh' });
    const first = await publishFiles(ctx, admin.user, { 'index.html': '<p>v1 secret</p>' });
    artifactId = first.artifact.id;
    v1 = first.version;
    clock.advance(1000);
  });
  afterEach(() => ctx.close());

  /** A link `who` makes, opened once as a guest would: unlocked if it has a password. */
  async function opened(
    who: Member,
    opts: { versionId?: string | null; password?: string | null; allowComments?: boolean } = {},
  ): Promise<Opened> {
    const { row, token } = await createShareLink(ctx.deps, who.user, artifactId, {
      versionId: opts.versionId ?? null,
      password: opts.password ?? null,
      expiresAt: null,
      allowComments: opts.allowComments ?? true,
    });
    let cookie: string | undefined;
    if (opts.password) {
      const r = await ctx.request(
        `/api/v1/share/${token}/unlock`,
        apiInit(ctx, { method: 'POST', body: { password: opts.password } }),
      );
      expect(r.status).toBe(204);
      cookie = r.headers.getSetCookie()[0]?.split(';')[0];
    }
    const r = await info(token, cookie);
    expect(r.status, await r.clone().text()).toBe(200);
    ShareInfo.parse(await r.json());
    const grants = await ctx.deps.db.db
      .selectFrom('content_grants')
      .select('token')
      .where('share_link_id', '=', row.id)
      .execute();
    expect(grants).toHaveLength(1);
    return { linkId: row.id, token, cookie, grant: grants[0]?.token ?? '' };
  }

  /** The three kinds of link `m` makes: following the current version, locked, and pinned. */
  const linksOfM = async () => [
    await opened(m),
    await opened(m, { password: PW, allowComments: false }),
    await opened(m, { versionId: v1.id, allowComments: false }),
  ];

  const info = (token: string, cookie?: string) =>
    ctx.request(`/api/v1/share/${token}`, apiInit(ctx, cookie === undefined ? {} : { cookie }));

  const guestComment = (token: string) =>
    ctx.request(
      `/api/v1/share/${token}/comments`,
      apiInit(ctx, {
        method: 'POST',
        body: { guest_name: 'Lan', body: 'Vẫn xem được?', anchor: sampleAnchor() },
      }),
    );

  const original = (link: Opened) =>
    ctx.request(
      `/s/${link.token}/original`,
      link.cookie === undefined ? {} : { headers: { cookie: link.cookie } },
    );

  async function reasonOf(r: Response) {
    return { status: r.status, reason: ((await r.json()) as ErrorJson).error.details?.reason };
  }

  const revokedAt = async (linkId: string) =>
    (
      await ctx.deps.db.db
        .selectFrom('share_links')
        .select('revoked_at')
        .where('id', '=', linkId)
        .executeTakeFirstOrThrow()
    ).revoked_at;

  /** The link still opens, serves its content and, when it allows them, takes guest comments. */
  async function expectWorking(link: Opened) {
    expect(await revokedAt(link.linkId)).toBeNull();
    expect((await info(link.token, link.cookie)).status).toBe(200);
    expect((await original(link)).status).toBe(302);
    expect((await fetchContent(ctx, link.grant, 'index.html')).status).toBe(200);
  }

  /** The link answers as a revoked link does everywhere a guest can use it. */
  async function expectRevoked(link: Opened) {
    expect(await revokedAt(link.linkId)).toBe(clock.now());
    expect(await reasonOf(await info(link.token, link.cookie))).toEqual({
      status: 410,
      reason: 'revoked',
    });
    expect(await reasonOf(await guestComment(link.token))).toEqual({
      status: 410,
      reason: 'revoked',
    });
    const page = await original(link);
    expect(page.status).toBe(410);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    // What the guest was already given ends too.
    expect((await fetchContent(ctx, link.grant, 'index.html')).status).toBe(410);
  }

  /** Each way a person loses access, as an admin or the access re-check brings it about. */
  const losses: [string, (user: UserRow) => Promise<void>][] = [
    [
      'Revoke now',
      async (user) => {
        const r = await ctx.request(
          `/api/v1/admin/users/${user.id}/revoke`,
          apiInit(ctx, { method: 'POST', cookie: admin.cookie }),
        );
        expect(r.status).toBe(200);
      },
    ],
    [
      'a block',
      async (user) => {
        const r = await ctx.request(
          `/api/v1/admin/users/${user.id}/role`,
          apiInit(ctx, { method: 'PUT', cookie: admin.cookie, body: { role_override: 'blocked' } }),
        );
        expect(r.status).toBe(200);
      },
    ],
    [
      'removal at the identity provider',
      async (user) => {
        await disableRemovedUser(ctx.deps, user.id);
      },
    ],
  ];

  test.each(losses)('%s revokes every share link the person made', async (_, lose) => {
    const links = await linksOfM();
    const kept = await opened(o);
    for (const link of [...links, kept]) await expectWorking(link);

    clock.advance(1000);
    await lose(m.user);
    for (const link of links) await expectRevoked(link);
    // Another member's link on the same artifact is not theirs to lose.
    await expectWorking(kept);

    // A new version is not served through the revoked links either.
    clock.advance(1000);
    await publishFiles(
      ctx,
      admin.user,
      { 'index.html': '<p>v2 newer secret</p>' },
      { kind: 'new_version', artifactId, expectedVersionId: v1.id },
    );
    for (const link of links) {
      const page = await original(link);
      expect(page.status).toBe(410);
      expect(await page.text()).not.toContain('newer secret');
    }

    // Members see them as revoked, and none is left active.
    const listed = await ctx.request(
      `/api/v1/artifacts/${artifactId}/share-links?include_revoked=true`,
      apiInit(ctx, { cookie: admin.cookie }),
    );
    const statuses = Object.fromEntries(
      ShareLinkList.parse(await listed.json()).items.map((link) => [link.id, link.status]),
    );
    expect(statuses).toEqual({
      ...Object.fromEntries(links.map((link) => [link.linkId, 'revoked'])),
      [kept.linkId]: 'active',
    });
  });

  test('a person who keeps access keeps their links', async () => {
    const links = await linksOfM();
    for (const role of ['admin', 'member', null]) {
      const r = await ctx.request(
        `/api/v1/admin/users/${m.user.id}/role`,
        apiInit(ctx, { method: 'PUT', cookie: admin.cookie, body: { role_override: role } }),
      );
      expect(r.status).toBe(200);
    }
    // Someone else losing access leaves them alone too.
    await revokeAllCredentials(ctx.deps, o.user.id);
    for (const link of links) await expectWorking(link);
  });

  test('revoking counts the links and leaves those already revoked as they were', async () => {
    const first = await opened(m);
    const second = await opened(m);
    const firstAt = clock.now();
    expect((await revokeAllCredentials(ctx.deps, m.user.id)).shareLinks).toBe(2);
    clock.advance(1000);
    await opened(m);
    expect((await revokeAllCredentials(ctx.deps, m.user.id)).shareLinks).toBe(1);
    for (const link of [first, second]) expect(await revokedAt(link.linkId)).toBe(firstAt);
  });

  test('links on a deleted artifact are skipped, and the rest are revoked', async () => {
    const other = await publishFiles(ctx, admin.user, { 'index.html': '<p>khác</p>' });
    const elsewhere = await createShareLink(ctx.deps, m.user, other.artifact.id, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: false,
    });
    const here = await opened(m);
    await deleteArtifact(ctx.deps, { user: admin.user, via: 'session' }, other.artifact.id);
    clock.advance(1000);
    expect((await revokeAllCredentials(ctx.deps, m.user.id)).shareLinks).toBe(1);
    await expectRevoked(here);
    expect(await reasonOf(await info(elsewhere.token))).toEqual({ status: 410, reason: 'deleted' });
  });

  test.runIf(dialect === 'postgres')(
    'a deletion holding the artifact goes first, then the revoke, without a deadlock',
    async () => {
      const link = await opened(m);
      const { db } = ctx.deps.db;
      let outcome: Promise<unknown> | undefined;
      // A deletion has locked the artifact and tombstoned the link's grant, as `deleteArtifact`
      // does before it deletes the row. A revoke that marked the link first would now wait on
      // that tombstone while the deletion waits on the link: a deadlock.
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('artifacts')
          .select('id')
          .where('id', '=', artifactId)
          .forUpdate()
          .execute();
        await addTombstones(
          trx,
          [{ kind: 'content_grant', key: link.grant, expiresAt: clock.now() + 60_000 }],
          clock.now(),
        );
        outcome = revokeAllCredentials(ctx.deps, m.user.id).then(
          (result) => result,
          (err: unknown) => err,
        );
        await untilWaitingOnALock(db, outcome);
        await trx.deleteFrom('artifacts').where('id', '=', artifactId).execute();
      });
      expect(await outcome).toMatchObject({ shareLinks: 0 });
    },
  );
});
