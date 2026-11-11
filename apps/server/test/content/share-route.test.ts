import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AuthContext } from '../../src/app.ts';
import { contentUrl } from '../../src/content/grants.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { deleteArtifact, deleteVersion } from '../../src/domain/deletion.ts';
import { createShareLink, revokeShareLink, shareUrl } from '../../src/domain/shares.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);
const SPA = '<!doctype html><title>SPA</title>';
const PW = 'Mật khẩu 1';
/** A page with a BOM and CRLF line ends: any transform on the way would show. */
const HTML = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('<!doctype html>\r\n<html><head><title>Giá</title></head><body>x</body></html>\r\n'),
]);

interface LinkOptions {
  versionId: string | null;
  password: string | null;
  expiresAt: number | null;
  allowComments: boolean;
}

describe.each([
  ['single-domain', {}],
  ['content-domain', CONTENT_ENV],
])('/s/:token in %s mode', (_mode, env) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let webDir: string;
  let member: { user: UserRow; cookie: string };

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'pinwall-web-'));
    await writeFile(join(webDir, 'index.html'), SPA);
    clock = new FixedClock(T);
    ctx = await createTestContext({ env: { ...env, PINWALL_WEB_DIR: webDir }, clock });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
  });
  afterEach(async () => {
    await ctx.close();
    await rm(webDir, { recursive: true, force: true });
  });

  const auth = (): AuthContext => ({ user: member.user, via: 'session' });

  /** Publishes `files` as a new artifact, or as a new version of `artifactId`. */
  async function publish(files: Record<string, string | Buffer>, artifactId?: string) {
    clock.advance(1000);
    if (artifactId === undefined) return publishFiles(ctx, member.user, files);
    const artifact = await ctx.deps.db.db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', artifactId)
      .executeTakeFirstOrThrow();
    return publishFiles(ctx, member.user, files, {
      kind: 'new_version',
      artifactId,
      expectedVersionId: artifact.current_version_id ?? '',
    });
  }

  async function share(artifactId: string, o: Partial<LinkOptions> = {}) {
    const { row, token } = await createShareLink(ctx.deps, member.user, artifactId, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: false,
      ...o,
    });
    return { linkId: row.id, token };
  }

  const open = (token: string, headers: Record<string, string> = {}) =>
    ctx.request(`/s/${token}`, { headers });

  /** `GET /s/<token>/original`, the share viewer's "Open original". */
  const openOriginal = (token: string, headers: Record<string, string> = {}) =>
    ctx.request(`/s/${token}/original`, { headers });

  const grantsOf = (linkId: string) =>
    ctx.deps.db.db
      .selectFrom('content_grants')
      .selectAll()
      .where('share_link_id', '=', linkId)
      .orderBy('created_at')
      .execute();

  /** The body served at the redirect target of `/s/<token>`. */
  async function served(token: string): Promise<string> {
    const r = await open(token);
    expect(r.status).toBe(302);
    return (await ctx.request(r.headers.get('location') ?? '')).text();
  }

  test('/s/:token redirects to a fresh raw grant served byte-for-byte', async () => {
    const html = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        '<!doctype html>\r\n<html><head><title>Giá</title></head><body>x</body></html>\r\n',
      ),
    ]);
    const { artifact, version } = await publish({ 'index.html': html });
    const { linkId, token } = await share(artifact.id);

    const r = await open(token);
    expect(r.status).toBe(302);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const grant = await ctx.deps.db.db
      .selectFrom('content_grants')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(grant).toMatchObject({
      mode: 'raw',
      share_link_id: linkId,
      user_id: null,
      version_id: version.id,
    });
    expect(r.headers.get('location')).toBe(contentUrl(ctx.deps.config, grant.token));
    const content = await ctx.request(r.headers.get('location') ?? '');
    expect(content.status).toBe(200);
    const body = Buffer.from(await content.arrayBuffer());
    expect(body.equals(html)).toBe(true);

    clock.advance(1000);
    const again = await open(token);
    expect(again.status).toBe(302);
    const grants = await grantsOf(linkId);
    expect(grants).toHaveLength(2);
    expect(grants[1]?.token).not.toBe(grant.token);
    expect(again.headers.get('location')).toBe(contentUrl(ctx.deps.config, grants[1]?.token ?? ''));
  });

  test('a link that follows the current version moves with publishes; a per-version link stays', async () => {
    const first = await publish({ 'index.html': '<p>one</p>' });
    const following = await share(first.artifact.id);
    const pinned = await share(first.artifact.id, { versionId: first.version.id });
    expect(await served(following.token)).toBe('<p>one</p>');

    await publish({ 'index.html': '<p>two</p>' }, first.artifact.id);
    expect(await served(following.token)).toBe('<p>two</p>');
    expect(await served(pinned.token)).toBe('<p>one</p>');
  });

  test('grants made from an expiring link end with it', async () => {
    const { artifact } = await publish({ 'index.html': '<p>soon</p>' });
    const expiresAt = clock.now() + 3_600_000;
    const { linkId, token } = await share(artifact.id, { expiresAt });
    expect((await open(token)).status).toBe(302);
    const [grant] = await grantsOf(linkId);
    expect(grant?.expires_at).toBe(expiresAt);

    // A link that lasts longer than a preview gives grants of the preview's length.
    const later = await share(artifact.id, { expiresAt: clock.now() + 30 * 86_400_000 });
    expect((await open(later.token)).status).toBe(302);
    const [long] = await grantsOf(later.linkId);
    expect(long?.expires_at).toBe(clock.now() + ctx.deps.config.ttl.previewMs);
  });

  test('deleted, revoked, expired and unknown links answer HTML pages', async () => {
    const one = await publish({ 'index.html': '<p>one</p>' });
    const two = await publish({ 'index.html': '<p>two</p>' }, one.artifact.id);
    const expiring = await share(one.artifact.id, { expiresAt: clock.now() + 1000 });
    const revoked = await share(one.artifact.id);
    const perVersion = await share(one.artifact.id, { versionId: one.version.id });
    expect(two.version.number).toBe(2);
    const other = await publish({ 'index.html': '<p>other</p>' });
    const deleted = await share(other.artifact.id);

    clock.advance(1000);
    await revokeShareLink(ctx.deps, member.user, revoked.linkId);
    await deleteVersion(ctx.deps, auth(), one.artifact.id, 1);
    await deleteArtifact(ctx.deps, auth(), other.artifact.id);

    const cases: [string, number, string, string][] = [
      [expiring.token, 410, 'share.expired.title', 'share.expired.message'],
      [revoked.token, 410, 'share.gone.title', 'share.gone.message'],
      [perVersion.token, 410, 'share.gone.title', 'share.gone.message'],
      [deleted.token, 410, 'share.gone.title', 'share.gone.message'],
      ['x'.repeat(43), 404, 'share.notFound.title', 'share.notFound.message'],
      ['nonsense', 404, 'share.notFound.title', 'share.notFound.message'],
    ];
    for (const [token, status, title, message] of cases) {
      for (const [accept, go] of [
        ['text/html', open],
        ['application/json', open],
        ['*/*', open],
        ['text/html', openOriginal],
        ['application/json', openOriginal],
      ] as const) {
        const r = await go(token, { accept });
        expect(r.status, `${title} with ${accept}`).toBe(status);
        expect(r.headers.get('content-type')).toBe('text/html; charset=UTF-8');
        expect(r.headers.get('cache-control')).toBe('no-store');
        expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
        const page = await r.text();
        expect(page).toContain(t(title));
        expect(page).toContain(t(message));
      }
    }
    expect(await ctx.deps.db.db.selectFrom('content_grants').selectAll().execute()).toEqual([]);
  });

  test('a password link or a link with comments opens the SPA', async () => {
    const { artifact } = await publish({ 'index.html': '<p>x</p>' });
    const locked = await share(artifact.id, { password: 'Mật khẩu 1' });
    const discussed = await share(artifact.id, { allowComments: true });
    for (const link of [locked, discussed]) {
      const r = await open(link.token, { accept: 'text/html' });
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await r.text()).toContain('<title>SPA</title>');
      expect(await grantsOf(link.linkId)).toEqual([]);
    }
  });

  test('opening links is rate limited per IP', async () => {
    const { artifact } = await publish({ 'index.html': '<p>x</p>' });
    const { token } = await share(artifact.id);
    for (let i = 0; i < 120; i++) expect((await open(token)).status).toBe(302);
    const r = await open(token, { accept: 'application/json' });
    expect(r.status).toBe(429);
    expect(r.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('retry-after')).toBe('600');
    // Unknown links count too: guessing is limited as much as opening.
    expect((await open('nonsense')).status).toBe(429);
    // "Open original" is an open as well.
    expect((await openOriginal(token)).status).toBe(429);
    clock.advance(600_000);
    expect((await open(token)).status).toBe(302);
  });

  test('/s/:token/original redirects a link with comments to a fresh raw grant, byte-for-byte', async () => {
    const { artifact, version } = await publish({ 'index.html': HTML });
    const { linkId, token } = await share(artifact.id, { allowComments: true });

    const r = await openOriginal(token, { accept: 'text/html' });
    expect(r.status).toBe(302);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const [grant] = await grantsOf(linkId);
    expect(grant).toMatchObject({
      mode: 'raw',
      share_link_id: linkId,
      user_id: null,
      version_id: version.id,
    });
    expect(r.headers.get('location')).toBe(contentUrl(ctx.deps.config, grant?.token ?? ''));
    const content = await ctx.request(r.headers.get('location') ?? '');
    expect(content.status).toBe(200);
    const body = Buffer.from(await content.arrayBuffer());
    expect(body.equals(HTML)).toBe(true);
    expect(body.toString()).not.toContain('data-pinwall-annotator');

    // One grant per open, as for `/s/:token`.
    clock.advance(1000);
    const again = await openOriginal(token);
    const grants = await grantsOf(linkId);
    expect(grants).toHaveLength(2);
    expect(again.headers.get('location')).toBe(contentUrl(ctx.deps.config, grants[1]?.token ?? ''));
  });

  test('/s/:token/original of a locked link goes to the password page until it is unlocked', async () => {
    const { artifact } = await publish({ 'index.html': HTML });
    const { linkId, token } = await share(artifact.id, { password: PW, allowComments: true });

    const locked = await openOriginal(token, { accept: 'text/html' });
    expect(locked.status).toBe(302);
    expect(locked.headers.get('cache-control')).toBe('no-store');
    expect(locked.headers.get('location')).toBe(shareUrl(ctx.deps.config, token));
    expect(await grantsOf(linkId)).toEqual([]);
    // A cookie that is not this link's unlock changes nothing.
    const wrong = await openOriginal(token, { cookie: 'pinwall_share=v1.1.x' });
    expect(wrong.headers.get('location')).toBe(shareUrl(ctx.deps.config, token));
    expect(await grantsOf(linkId)).toEqual([]);

    const unlocked = await ctx.request(
      `/api/v1/share/${token}/unlock`,
      apiInit(ctx, { method: 'POST', body: { password: PW } }),
    );
    expect(unlocked.status).toBe(204);
    // The cookie set for `/s/<token>` is sent for `/s/<token>/original` too (RFC 6265 path-match).
    const forPage = unlocked.headers.getSetCookie().find((c) => c.includes(`Path=/s/${token}`));
    const cookie = forPage?.split(';')[0] ?? '';
    const r = await openOriginal(token, { cookie });
    expect(r.status).toBe(302);
    const [grant] = await grantsOf(linkId);
    expect(grant).toMatchObject({ mode: 'raw', share_link_id: linkId });
    expect(r.headers.get('location')).toBe(contentUrl(ctx.deps.config, grant?.token ?? ''));
    const body = Buffer.from(
      await (await ctx.request(r.headers.get('location') ?? '')).arrayBuffer(),
    );
    expect(body.equals(HTML)).toBe(true);
  });

  test('last use is recorded at most once a minute', async () => {
    const { artifact } = await publish({ 'index.html': '<p>x</p>' });
    const { linkId, token } = await share(artifact.id);
    const lastUsed = async () =>
      (
        await ctx.deps.db.db
          .selectFrom('share_links')
          .select('last_used_at')
          .where('id', '=', linkId)
          .executeTakeFirstOrThrow()
      ).last_used_at;

    expect(await lastUsed()).toBeNull();
    await open(token);
    const first = clock.now();
    expect(await lastUsed()).toBe(first);
    clock.advance(30_000);
    await open(token);
    expect(await lastUsed()).toBe(first);
    clock.advance(30_000);
    await open(token);
    expect(await lastUsed()).toBe(first + 60_000);
  });
});
