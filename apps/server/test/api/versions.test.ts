import { VersionFileList, VersionList, VersionSummary } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { sha } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

describe.each(dialects)('versions over REST on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };
  let api: ReturnType<typeof restClient>;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    api = restClient(ctx, member.cookie);
  });
  afterEach(() => ctx.close());

  /** Publishes `texts[0]` as a new artifact and each later text as a version on top. */
  async function history(texts: string[]) {
    const [first, ...rest] = texts as [string, ...string[]];
    const { artifact, version } = await publishFiles(ctx, member.user, {
      'index.html': `<p>${first}</p>`,
    });
    const versions = [version];
    for (const text of rest) {
      clock.advance(1000);
      const next = await publishFiles(
        ctx,
        member.user,
        { 'index.html': `<p>${text}</p>` },
        {
          kind: 'new_version',
          artifactId: artifact.id,
          expectedVersionId: versions.at(-1)?.id ?? '',
        },
      );
      versions.push(next.version);
    }
    return { artifact, versions };
  }

  test('versions list newest first, files page by path', async () => {
    const { artifact, versions } = await history(['one', 'two', 'three']);
    const r = await api.get(`/artifacts/${artifact.id}/versions`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const list = VersionList.parse(r.body);
    expect(list.items.map((v) => [v.number, v.is_current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(list.items.map((v) => v.id)).toEqual(versions.map((v) => v.id).reverse());
    expect(list.next_cursor).toBeNull();

    const first = VersionList.parse(
      (await api.get(`/artifacts/${artifact.id}/versions?limit=2`)).body,
    );
    expect(first.items.map((v) => v.number)).toEqual([3, 2]);
    const second = VersionList.parse(
      (
        await api.get(
          `/artifacts/${artifact.id}/versions?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
        )
      ).body,
    );
    expect(second.items.map((v) => v.number)).toEqual([1]);
    expect(second.next_cursor).toBeNull();
    expect((await api.get(`/artifacts/${artifact.id}/versions?cursor=garbage`)).status).toBe(400);

    const files = await publishFiles(
      ctx,
      member.user,
      {
        'index.html': '<link rel="stylesheet" href="b.css"><script src="c.js"></script>',
        'c.js': 'console.log(1)',
        'b.css': 'p{color:red}',
        'assets/a.txt': 'text',
      },
      {
        kind: 'new_version',
        artifactId: artifact.id,
        expectedVersionId: versions[2]?.id ?? '',
      },
    );
    const path = `/artifacts/${artifact.id}/versions/4/files`;
    const all = VersionFileList.parse((await api.get(path)).body);
    expect(all.items.map((f) => f.path)).toEqual(['assets/a.txt', 'b.css', 'c.js', 'index.html']);
    expect(all.items[0]).toEqual({
      path: 'assets/a.txt',
      size: 4,
      content_type: 'text/plain; charset=utf-8',
      sha256: sha('text'),
    });
    expect(files.version.file_count).toBe(4);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string =
        cursor === null ? '?limit=1' : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const { body }: { body: unknown } = await api.get(`${path}${q}`);
      const p = VersionFileList.parse(body);
      expect(p.items.length).toBeLessThanOrEqual(1);
      seen.push(...p.items.map((f) => f.path));
      cursor = p.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(['assets/a.txt', 'b.css', 'c.js', 'index.html']);
  });

  test('one version reads as its summary', async () => {
    const { artifact, versions } = await history(['one', 'two']);
    const r = await api.get(`/artifacts/${artifact.id}/versions/1`);
    expect(r.status).toBe(200);
    expect(VersionSummary.parse(r.body)).toEqual({
      id: versions[0]?.id,
      number: 1,
      title: null,
      entry_path: 'index.html',
      theme_color: null,
      has_thumbnail: false,
      file_count: 1,
      total_bytes: versions[0]?.total_bytes,
      message: null,
      source: 'api',
      restored_from_version_id: null,
      warnings: [],
      created_by: member.user.id,
      created_at: T,
      is_current: false,
    });
    expect(
      VersionSummary.parse((await api.get(`/artifacts/${artifact.id}/versions/2`)).body),
    ).toMatchObject({
      number: 2,
      is_current: true,
      created_at: T + 1000,
    });
  });

  test('a version that does not exist is 404, a deleted one is 410', async () => {
    const { artifact, versions } = await history(['one', 'two']);
    const unknown = await api.get<ErrorJson>(`/artifacts/${artifact.id}/versions/9`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(t('version.notFound'));
    expect((await api.get(`/artifacts/${artifact.id}/versions/9/files`)).status).toBe(404);
    for (const n of ['0', '-1', 'x', '1.5']) {
      expect((await api.get(`/artifacts/${artifact.id}/versions/${n}`)).status, n).toBe(400);
    }

    await ctx.deps.db.db
      .deleteFrom('versions')
      .where('id', '=', versions[0]?.id ?? '')
      .execute();
    const gone = await api.get<ErrorJson>(`/artifacts/${artifact.id}/versions/1`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toMatchObject({ code: 'gone', message: t('version.gone') });
    expect((await api.get(`/artifacts/${artifact.id}/versions/1/files`)).status).toBe(410);
    expect(
      VersionList.parse((await api.get(`/artifacts/${artifact.id}/versions`)).body).items.map(
        (v) => v.number,
      ),
    ).toEqual([2]);

    expect((await api.get('/artifacts/art_nope/versions')).status).toBe(404);
    expect((await api.get('/artifacts/art_nope/versions/1')).status).toBe(404);
  });

  test('restore over REST', async () => {
    const { artifact, versions } = await history(['alpha one', 'beta two']);
    const [v1, v2] = versions as [(typeof versions)[0], (typeof versions)[0]];

    const r = await api.post(`/artifacts/${artifact.id}/versions/1/restore`, {
      expected_version_id: v2.id,
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const restored = VersionSummary.parse(r.body);
    expect(restored).toMatchObject({
      number: 3,
      source: 'restore',
      restored_from_version_id: v1.id,
      message: t('version.restoredFrom', { number: 1 }),
      is_current: true,
    });

    const summary = (await api.get(`/artifacts/${artifact.id}`)).body as {
      current_version: { number: number };
      latest_number: number;
    };
    expect(summary.current_version.number).toBe(3);
    expect(summary.latest_number).toBe(3);
    // Search follows the restored text.
    const found = async (q: string) =>
      ((await api.get(`/artifacts?q=${q}`)).body as { items: { id: string }[] }).items.length;
    expect(await found('alpha')).toBe(1);
    expect(await found('beta')).toBe(0);

    // The old current version is no longer the one to build on.
    const stale = await api.post<ErrorJson>(`/artifacts/${artifact.id}/versions/1/restore`, {
      expected_version_id: v2.id,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: restored.id, current_version_number: 3 },
    });
  });

  test('restore refuses a bad request', async () => {
    const { artifact, versions } = await history(['one', 'two']);
    const expected = versions[1]?.id ?? '';
    expect((await api.post(`/artifacts/${artifact.id}/versions/1/restore`, {})).status).toBe(400);
    expect(
      (
        await api.post(`/artifacts/${artifact.id}/versions/7/restore`, {
          expected_version_id: expected,
        })
      ).status,
    ).toBe(404);
    expect(
      (await api.post('/artifacts/art_nope/versions/1/restore', { expected_version_id: expected }))
        .status,
    ).toBe(404);
    // Nothing was written by the refused attempts.
    expect(
      VersionList.parse((await api.get(`/artifacts/${artifact.id}/versions`)).body).items,
    ).toHaveLength(2);
  });

  test('every version route needs a signed-in user', async () => {
    const { artifact, versions } = await history(['one']);
    const anonymous = restClient(ctx, '');
    for (const r of [
      await anonymous.get(`/artifacts/${artifact.id}/versions`),
      await anonymous.get(`/artifacts/${artifact.id}/versions/1`),
      await anonymous.get(`/artifacts/${artifact.id}/versions/1/files`),
      await anonymous.post(`/artifacts/${artifact.id}/versions/1/restore`, {
        expected_version_id: versions[0]?.id,
      }),
    ]) {
      expect(r.status).toBe(401);
    }
  });
});
