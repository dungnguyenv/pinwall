import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { idpAccessDeadline } from '../../src/auth/oidc/gate.ts';
import { contentUrl } from '../../src/content/grants.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** The grant token in a single-domain content URL. */
function tokenOf(location: string): string {
  const match = /^http:\/\/localhost:8080\/c\/([0-9a-hjkmnp-tv-z]{32})\/$/.exec(location);
  if (match?.[1] === undefined) throw new Error(`not a content URL: ${location}`);
  return match[1];
}

describe.each(dialects)('raw links on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    member = await createSignedInUser(ctx);
  });
  afterEach(() => ctx.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    ctx.request(path, { headers, redirect: 'manual' });

  const grantRow = (token: string) =>
    ctx.deps.db.db
      .selectFrom('content_grants')
      .selectAll()
      .where('token', '=', token)
      .executeTakeFirstOrThrow();

  test('raw links redirect members to a fresh raw grant', async () => {
    const { artifact, version } = await publishFiles(ctx, member.user, {
      'index.html': '<p>raw</p>',
    });
    clock.advance(5_000);

    const r = await get(`/a/${artifact.id}/raw`, { cookie: member.cookie, accept: BROWSER });
    expect(r.status).toBe(302);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const location = r.headers.get('location') ?? '';
    const token = tokenOf(location);
    expect(location).toBe(contentUrl(ctx.deps.config, token));
    expect(await grantRow(token)).toMatchObject({
      version_id: version.id,
      mode: 'raw',
      share_link_id: null,
      expires_at: clock.now() + ctx.deps.config.ttl.previewMs,
    });
    const served = await ctx.request(location);
    expect(await served.text()).toBe('<p>raw</p>');

    const bearer = await createUserToken(ctx, member.user.id);
    const viaToken = await get(`/a/${artifact.id}/raw`, { authorization: `Bearer ${bearer}` });
    expect(viaToken.status).toBe(302);
    const other = tokenOf(viaToken.headers.get('location') ?? '');
    expect(other).not.toBe(token);
    expect((await grantRow(other)).mode).toBe('raw');
  });

  test('an IdP user gets a raw grant that ends with their access', async () => {
    const linh = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    const { artifact } = await publishFiles(ctx, linh.user, { 'index.html': '<p>x</p>' });
    // An hour after the IdP check: the access bound now comes before the preview TTL.
    clock.advance(3_600_000);
    const r = await get(`/a/${artifact.id}/raw`, { cookie: linh.cookie });
    expect(r.status).toBe(302);
    const deadline = idpAccessDeadline(linh.user, ctx.deps.config);
    expect(deadline).not.toBeNull();
    expect(deadline).toBeLessThan(clock.now() + ctx.deps.config.ttl.previewMs);
    const grant = await grantRow(tokenOf(r.headers.get('location') ?? ''));
    expect(grant.expires_at).toBe(deadline);
  });

  test('raw links keep their query on the content URL', async () => {
    const markdown = '# Ghi chú\n\nXin chào\n';
    const { artifact } = await publishFiles(ctx, member.user, { 'notes.md': markdown });
    const page = await get(`/a/${artifact.id}/raw`, { cookie: member.cookie });
    const rendered = await ctx.request(page.headers.get('location') ?? '');
    expect(rendered.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await rendered.text()).toContain('Xin chào');

    const source = await get(`/a/${artifact.id}/raw?source`, { cookie: member.cookie });
    const location = source.headers.get('location') ?? '';
    expect(location).toMatch(/\/\?source$/);
    const stored = await ctx.request(location);
    expect(stored.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await stored.text()).toBe(markdown);
  });

  test('raw links send browsers without a session to sign in', async () => {
    const { artifact } = await publishFiles(ctx, member.user, { 'index.html': '<p>x</p>' });
    const browser = await get(`/a/${artifact.id}/raw`, { accept: BROWSER });
    expect(browser.status).toBe(302);
    expect(browser.headers.get('location')).toBe(
      `http://localhost:8080/signin?return_to=%2Fa%2F${artifact.id}%2Fraw`,
    );
    expect(browser.headers.get('cache-control')).toBe('no-store');

    const versioned = await get(`/a/${artifact.id}/v/1/raw?source`, { accept: BROWSER });
    expect(versioned.headers.get('location')).toBe(
      `http://localhost:8080/signin?return_to=${encodeURIComponent(`/a/${artifact.id}/v/1/raw?source`)}`,
    );

    // Whether an artifact exists is not shown to someone not signed in.
    const unknown = await get('/a/art_unknown/raw', { accept: BROWSER });
    expect(unknown.status).toBe(302);

    const program = await get(`/a/${artifact.id}/raw`, { accept: 'application/json' });
    expect(program.status).toBe(401);
    expect(await program.json()).toEqual({
      error: { code: 'unauthorized', message: t('auth.signInRequired') },
    });
    const unknownSession = await get(`/a/${artifact.id}/raw`, {
      cookie: 'pinwall_session=nonsense',
    });
    expect(unknownSession.status).toBe(401);

    const badToken = await get(`/a/${artifact.id}/raw`, { authorization: 'Bearer nope' });
    expect(badToken.status).toBe(401);
    expect(badToken.headers.get('location')).toBeNull();
  });

  test('/a/:id/v/:n/raw serves that version', async () => {
    const one = await publishFiles(ctx, member.user, { 'index.html': 'one' });
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': 'two' },
      { kind: 'new_version', artifactId: one.artifact.id, expectedVersionId: one.version.id },
    );
    const open = async (path: string) => {
      const r = await get(path, { cookie: member.cookie });
      expect(r.status, path).toBe(302);
      return (await ctx.request(r.headers.get('location') ?? '')).text();
    };
    expect(await open(`/a/${one.artifact.id}/v/1/raw`)).toBe('one');
    expect(await open(`/a/${one.artifact.id}/v/2/raw`)).toBe('two');
    expect(await open(`/a/${one.artifact.id}/raw`)).toBe('two');
  });

  test('raw links of deleted things are gone', async () => {
    const one = await publishFiles(ctx, member.user, { 'index.html': 'one' });
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': 'two' },
      { kind: 'new_version', artifactId: one.artifact.id, expectedVersionId: one.version.id },
    );
    await ctx.deps.db.db.deleteFrom('versions').where('id', '=', one.version.id).execute();

    const deletedVersion = await get(`/a/${one.artifact.id}/v/1/raw`, {
      cookie: member.cookie,
      accept: BROWSER,
    });
    expect(deletedVersion.status).toBe(410);
    expect(deletedVersion.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(deletedVersion.headers.get('cache-control')).toBe('no-store');
    expect(await deletedVersion.text()).toContain(t('version.gone'));

    for (const n of ['3', '0', 'x', '1.5', '01x']) {
      const r = await get(`/a/${one.artifact.id}/v/${n}/raw`, { cookie: member.cookie });
      expect(r.status, n).toBe(404);
      expect(((await r.json()) as { error: { message: string } }).error.message).toBe(
        t('version.notFound'),
      );
    }

    await ctx.deps.db.db.deleteFrom('artifacts').where('id', '=', one.artifact.id).execute();
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: one.artifact.id, expiresAt: null }],
      clock.now(),
    );
    for (const path of [`/a/${one.artifact.id}/raw`, `/a/${one.artifact.id}/v/2/raw`]) {
      const r = await get(path, { cookie: member.cookie, accept: BROWSER });
      expect(r.status, path).toBe(410);
      expect(await r.text()).toContain(t('artifact.gone'));
    }

    const unknown = await get('/a/art_unknown/raw', { cookie: member.cookie, accept: BROWSER });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(await unknown.text()).toContain(t('artifact.notFound'));
  });
});
