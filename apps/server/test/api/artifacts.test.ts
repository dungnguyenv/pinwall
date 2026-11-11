import { ArtifactList, ArtifactSummary } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { toArtifactSummary } from '../../src/api/artifacts.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { recordView } from '../../src/domain/artifacts.ts';
import { createProject, updateProject } from '../../src/domain/projects.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

describe.each(dialects)('artifacts over REST on %s', (dialect) => {
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

  const publish = (
    files: Record<string, string>,
    o: { name?: string; projectId?: string; tags?: string[] } = {},
  ) =>
    publishFiles(ctx, member.user, files, {
      kind: 'new_artifact',
      projectId: o.projectId ?? null,
      name: o.name ?? null,
      tags: o.tags ?? [],
    });

  const search = async (q: string): Promise<string[]> => {
    const r = await api.get(`/artifacts?q=${encodeURIComponent(q)}`);
    expect(r.status).toBe(200);
    return ArtifactList.parse(r.body).items.map((a) => a.id);
  };

  /** Every page of `path`, following `next_cursor`. */
  async function pages(path: string, limit: number): Promise<string[][]> {
    const out: string[][] = [];
    let cursor: string | null = null;
    do {
      const sep: string = path.includes('?') ? '&' : '?';
      const more: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const r: { status: number; body: unknown } = await api.get(
        `${path}${sep}limit=${limit}${more}`,
      );
      expect(r.status).toBe(200);
      const list = ArtifactList.parse(r.body);
      out.push(list.items.map((a) => a.id));
      cursor = list.next_cursor;
    } while (cursor !== null);
    return out;
  }

  test('an artifact reads as its summary', async () => {
    const { artifact, version } = await publish(
      { 'index.html': '<title>Báo giá</title><img src="/logo.png">' },
      { name: 'Báo giá', tags: ['Khách hàng', 'q4'] },
    );
    const r = await api.get(`/artifacts/${artifact.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const summary = ArtifactSummary.parse(r.body);
    expect(summary).toEqual({
      id: artifact.id,
      project_id: artifact.project_id,
      name: 'Báo giá',
      kind: 'html',
      tags: ['khách hàng', 'q4'],
      latest_number: 1,
      created_by: member.user.id,
      created_at: T,
      updated_at: T,
      links: {
        review: `${ctx.deps.config.publicOrigin}/a/${artifact.id}`,
        raw: `${ctx.deps.config.publicOrigin}/a/${artifact.id}/raw`,
      },
      current_version: {
        id: version.id,
        number: 1,
        title: 'Báo giá',
        entry_path: 'index.html',
        theme_color: null,
        has_thumbnail: false,
        file_count: 1,
        total_bytes: version.total_bytes,
        message: null,
        source: 'api',
        restored_from_version_id: null,
        warnings: [expect.objectContaining({ code: 'root_absolute_url', url: '/logo.png' })],
        created_by: member.user.id,
        created_at: T,
        is_current: true,
      },
    });
  });

  test('a markdown artifact says so', async () => {
    const { artifact } = await publish({ 'index.md': '# Ghi chú' });
    const summary = ArtifactSummary.parse((await api.get(`/artifacts/${artifact.id}`)).body);
    expect(summary.kind).toBe('markdown');
    expect(summary.current_version?.entry_path).toBe('index.md');
  });

  test('search finds Vietnamese without diacritics', async () => {
    const { artifact } = await publish({ 'index.html': '<p>Dịch vụ chụp ảnh cưới</p>' });
    for (const q of ['chup anh', 'chụp ảnh', 'CHUP']) {
      expect(await search(q), q).toEqual([artifact.id]);
    }
    expect(await search('khong co')).toEqual([]);
  });

  test('search covers name and tags and follows the current version', async () => {
    const { artifact, version } = await publish(
      { 'index.html': '<p>Dịch vụ chụp ảnh cưới</p>' },
      { name: 'Báo giá cũ' },
    );
    expect(await search('bao gia cu')).toEqual([artifact.id]);

    const renamed = await api.patch(`/artifacts/${artifact.id}`, { name: 'Bảng giá' });
    expect(renamed.status).toBe(200);
    expect(await search('bang gia')).toEqual([artifact.id]);
    expect(await search('bao gia cu')).toEqual([]);

    expect(await search('khach')).toEqual([]);
    await api.patch(`/artifacts/${artifact.id}`, { tags: ['Khách hàng'] });
    expect(await search('khach')).toEqual([artifact.id]);
    // Removing the tag takes it out of the index again.
    await api.patch(`/artifacts/${artifact.id}`, { tags: [] });
    expect(await search('khach')).toEqual([]);

    expect(await search('cuoi')).toEqual([artifact.id]);
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>Dịch vụ chụp ảnh</p>' },
      {
        kind: 'new_version',
        artifactId: artifact.id,
        expectedVersionId: version.id,
      },
    );
    expect(await search('cuoi')).toEqual([]);
    expect(await search('chup')).toEqual([artifact.id]);
  });

  test('search input is capped', async () => {
    const words = Array.from({ length: 32 }, (_, i) => `ab${i}`);
    const { artifact } = await publish({ 'index.html': `<p>${words.join(' ')}</p>` });

    const long = await api.get<ErrorJson>(`/artifacts?q=${'a'.repeat(257)}`);
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('bad_request');
    expect((await api.get(`/artifacts?q=${'a'.repeat(256)}`)).status).toBe(200);

    // Words past the 32nd are ignored: 8 words that match nothing change nothing.
    const stray = Array.from({ length: 8 }, (_, i) => `zz${i}`);
    expect(await search([...words, ...stray].join(' '))).toEqual([artifact.id]);
    // The 32nd word still counts.
    expect(await search([...words.slice(0, 31), 'zz0'].join(' '))).toEqual([]);
  });

  test('a query of punctuation or blanks matches nothing, and an empty one lists everything', async () => {
    const { artifact } = await publish({ 'index.html': '<p>hello</p>' });
    expect(await search('!!! ???')).toEqual([]);
    expect(await search('')).toEqual([artifact.id]);
    expect(await search('   ')).toEqual([artifact.id]);
  });

  test('search pages by offset and stops where it started', async () => {
    const made: string[] = [];
    for (const i of [1, 2, 3]) {
      made.push((await publish({ 'index.html': `<p>common phrase ${i}</p>` })).artifact.id);
    }
    const found = await pages('/artifacts?q=common', 2);
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveLength(2);
    expect(found[1]).toHaveLength(1);
    expect(found.flat().sort()).toEqual([...made].sort());

    const bad = await api.get<ErrorJson>(`/artifacts?q=common&cursor=${btoa('{"u":1,"i":"x"}')}`);
    expect(bad.status).toBe(400);
  });

  test('search honors the project and tag filters and leaves archived projects out', async () => {
    const other = await createProject(ctx.deps, member.user, { name: 'Other' });
    const a = await publish({ 'index.html': '<p>shared words</p>' }, { tags: ['red'] });
    const b = await publish(
      { 'index.html': '<p>shared words</p>' },
      { projectId: other.id, tags: ['red', 'blue'] },
    );
    const c = await publish({ 'index.html': '<p>shared words</p>' }, { tags: ['blue'] });

    const ids = async (query: string) => {
      const r = await api.get(`/artifacts?${query}`);
      expect(r.status, query).toBe(200);
      return ArtifactList.parse(r.body)
        .items.map((x) => x.id)
        .sort();
    };
    const sorted = (...x: { artifact: { id: string } }[]) => x.map((y) => y.artifact.id).sort();
    expect(await ids('q=shared')).toEqual(sorted(a, b, c));
    expect(await ids('q=shared&tag=red')).toEqual(sorted(a, b));
    expect(await ids(`q=shared&project_id=${other.id}`)).toEqual(sorted(b));
    expect(await ids(`q=shared&project_id=${other.id}&tag=blue`)).toEqual(sorted(b));
    expect(await ids('q=shared&tag=green')).toEqual([]);

    await updateProject(ctx.deps, other.id, { archived: true });
    expect(await ids('q=shared')).toEqual(sorted(a, c));
    expect(await ids(`q=shared&project_id=${other.id}`)).toEqual(sorted(b));
  });

  test('the list orders by last update and pages with a cursor', async () => {
    const ids: string[] = [];
    for (const i of [1, 2, 3]) {
      ids.push((await publish({ 'index.html': `<p>${i}</p>` })).artifact.id);
      clock.advance(1000);
    }
    const [first, second, third] = ids as [string, string, string];

    const page1 = await api.get('/artifacts?limit=2');
    const list1 = ArtifactList.parse(page1.body);
    expect(list1.items.map((a) => a.id)).toEqual([third, second]);
    expect(list1.next_cursor).toEqual(expect.any(String));

    const page2 = ArtifactList.parse(
      (await api.get(`/artifacts?limit=2&cursor=${encodeURIComponent(list1.next_cursor ?? '')}`))
        .body,
    );
    expect(page2.items.map((a) => a.id)).toEqual([first]);
    expect(page2.next_cursor).toBeNull();

    const bad = await api.get<ErrorJson>('/artifacts?cursor=garbage');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'bad_request', message: t('error.cursor') });
    expect((await api.get('/artifacts?limit=201')).status).toBe(400);
  });

  test('artifacts updated at the same moment page without a repeat or a gap', async () => {
    const ids: string[] = [];
    for (const i of [1, 2, 3, 4, 5])
      ids.push((await publish({ 'index.html': `<p>${i}</p>` })).artifact.id);
    const found = (await pages('/artifacts', 2)).flat();
    expect(found).toHaveLength(5);
    expect(found.sort()).toEqual([...ids].sort());
  });

  test('a rename or a new tag counts as an update', async () => {
    const old = (await publish({ 'index.html': '<p>old</p>' })).artifact.id;
    clock.advance(1000);
    const recent = (await publish({ 'index.html': '<p>recent</p>' })).artifact.id;
    clock.advance(1000);
    const renamed = ArtifactSummary.parse(
      (await api.patch(`/artifacts/${old}`, { name: 'Renamed' })).body,
    );
    expect(renamed.updated_at).toBe(T + 2000);
    expect(ArtifactList.parse((await api.get('/artifacts')).body).items.map((a) => a.id)).toEqual([
      old,
      recent,
    ]);
  });

  test('artifacts of archived projects leave the default list', async () => {
    const project = await createProject(ctx.deps, member.user, { name: 'P' });
    const inProject = (await publish({ 'index.html': '<p>p</p>' }, { projectId: project.id }))
      .artifact.id;
    const inDefault = (await publish({ 'index.html': '<p>d</p>' })).artifact.id;
    const idsOf = async (path: string) =>
      ArtifactList.parse((await api.get(path)).body)
        .items.map((a) => a.id)
        .sort();

    expect(await idsOf('/artifacts')).toEqual([inProject, inDefault].sort());
    await updateProject(ctx.deps, project.id, { archived: true });
    expect(await idsOf('/artifacts')).toEqual([inDefault]);
    expect(await idsOf(`/artifacts?project_id=${project.id}`)).toEqual([inProject]);

    const missing = await api.get<ErrorJson>('/artifacts?project_id=prj_nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe(t('project.notFound'));
  });

  test('tags are normalized and capped', async () => {
    const { artifact } = await publish({ 'index.html': '<p>t</p>' });
    const patched = await api.patch(`/artifacts/${artifact.id}`, {
      tags: [' Đồ Án ', 'đồ án', 'X'],
    });
    expect(patched.status).toBe(200);
    expect(ArtifactSummary.parse(patched.body).tags).toEqual(['x', 'đồ án']);
    expect(ArtifactSummary.parse((await api.get(`/artifacts/${artifact.id}`)).body).tags).toEqual([
      'x',
      'đồ án',
    ]);

    const tooMany = await api.patch<ErrorJson>(`/artifacts/${artifact.id}`, {
      tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
    });
    expect(tooMany.status).toBe(400);
    const tooLong = await api.patch<ErrorJson>(`/artifacts/${artifact.id}`, {
      tags: ['x'.repeat(41)],
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatchObject({
      code: 'bad_request',
      message: t('artifact.badTags'),
    });
    expect((await api.patch(`/artifacts/${artifact.id}`, { tags: ['  '] })).status).toBe(400);
    // Two tags that differ only by a lone surrogate would collide in the database.
    expect(
      (await api.patch(`/artifacts/${artifact.id}`, { tags: ['\ud800', '\ud801'] })).status,
    ).toBe(400);
    // None of the refused changes took effect.
    expect(ArtifactSummary.parse((await api.get(`/artifacts/${artifact.id}`)).body).tags).toEqual([
      'x',
      'đồ án',
    ]);
  });

  test('the list filters by tag, whatever the spelling', async () => {
    const tagged = (await publish({ 'index.html': '<p>1</p>' }, { tags: ['Đồ Án'] })).artifact.id;
    await publish({ 'index.html': '<p>2</p>' }, { tags: ['other'] });
    for (const tag of ['đồ án', 'Đồ  Án', encodeURIComponent('ĐỒ ÁN')]) {
      const list = ArtifactList.parse((await api.get(`/artifacts?tag=${tag}`)).body);
      expect(
        list.items.map((a) => a.id),
        tag,
      ).toEqual([tagged]);
    }
    expect((await api.get(`/artifacts?tag=${'x'.repeat(41)}`)).status).toBe(400);
  });

  test('move to another project', async () => {
    const q = await createProject(ctx.deps, member.user, { name: 'Q' });
    const archived = await createProject(ctx.deps, member.user, { name: 'Old' });
    await updateProject(ctx.deps, archived.id, { archived: true });
    const { artifact } = await publish({ 'index.html': '<p>m</p>' });

    const moved = await api.patch(`/artifacts/${artifact.id}`, { project_id: q.id });
    expect(moved.status).toBe(200);
    expect(ArtifactSummary.parse(moved.body).project_id).toBe(q.id);
    const under = ArtifactList.parse((await api.get(`/artifacts?project_id=${q.id}`)).body);
    expect(under.items.map((a) => a.id)).toEqual([artifact.id]);

    const nope = await api.patch<ErrorJson>(`/artifacts/${artifact.id}`, {
      project_id: 'prj_nope',
    });
    expect(nope.status).toBe(404);
    expect(nope.body.error.message).toBe(t('project.notFound'));
    const shelved = await api.patch<ErrorJson>(`/artifacts/${artifact.id}`, {
      project_id: archived.id,
    });
    expect(shelved.status).toBe(409);
    expect(shelved.body.error).toMatchObject({ code: 'conflict', message: t('project.archived') });
    expect(
      ArtifactSummary.parse((await api.get(`/artifacts/${artifact.id}`)).body).project_id,
    ).toBe(q.id);
  });

  test('a rename and a move in one change are both applied or neither is', async () => {
    const { artifact } = await publish({ 'index.html': '<p>x</p>' }, { name: 'Before' });
    const r = await api.patch(`/artifacts/${artifact.id}`, {
      name: 'After',
      tags: ['new'],
      project_id: 'prj_nope',
    });
    expect(r.status).toBe(404);
    const still = ArtifactSummary.parse((await api.get(`/artifacts/${artifact.id}`)).body);
    expect(still).toMatchObject({ name: 'Before', tags: [], updated_at: T });
  });

  test('a name is trimmed and cannot be empty or longer than 200 characters', async () => {
    const { artifact } = await publish({ 'index.html': '<p>n</p>' });
    const ok = await api.patch(`/artifacts/${artifact.id}`, { name: '  Spaced out  ' });
    expect(ArtifactSummary.parse(ok.body).name).toBe('Spaced out');
    for (const name of ['', '   ', 'x'.repeat(201)]) {
      expect((await api.patch(`/artifacts/${artifact.id}`, { name })).status).toBe(400);
    }
  });

  test('an empty change changes nothing', async () => {
    const { artifact } = await publish({ 'index.html': '<p>n</p>' });
    clock.advance(5000);
    const r = await api.patch(`/artifacts/${artifact.id}`, {});
    expect(r.status).toBe(200);
    expect(ArtifactSummary.parse(r.body).updated_at).toBe(T);
  });

  test('recent lists what the user viewed, newest first', async () => {
    const a = (await publish({ 'index.html': '<p>a</p>' })).artifact.id;
    const b = (await publish({ 'index.html': '<p>b</p>' })).artifact.id;
    const c = (await publish({ 'index.html': '<p>c</p>' })).artifact.id;
    const other = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });

    await recordView(ctx.deps, member.user.id, a);
    clock.advance(1000);
    await recordView(ctx.deps, member.user.id, b);
    clock.advance(1000);
    await recordView(ctx.deps, other.user.id, c);

    const recent = await api.get('/artifacts/recent');
    expect(recent.status).toBe(200);
    const list = ArtifactList.parse(recent.body);
    expect(list.items.map((x) => x.id)).toEqual([b, a]);
    expect(list.next_cursor).toBeNull();

    // Viewing again brings it to the front, without a second row.
    clock.advance(1000);
    await recordView(ctx.deps, member.user.id, a);
    expect(
      ArtifactList.parse((await api.get('/artifacts/recent')).body).items.map((x) => x.id),
    ).toEqual([a, b]);
    expect(
      ArtifactList.parse((await api.get('/artifacts/recent?limit=1')).body).items.map((x) => x.id),
    ).toEqual([a]);
    expect(
      ArtifactList.parse(
        (await restClient(ctx, other.cookie).get('/artifacts/recent')).body,
      ).items.map((x) => x.id),
    ).toEqual([c]);
    expect((await api.get('/artifacts/recent?limit=21')).status).toBe(400);
  });

  test('recent leaves out artifacts of archived projects and deleted ones', async () => {
    const project = await createProject(ctx.deps, member.user, { name: 'P' });
    const shelved = (await publish({ 'index.html': '<p>s</p>' }, { projectId: project.id }))
      .artifact.id;
    const kept = (await publish({ 'index.html': '<p>k</p>' })).artifact.id;
    await recordView(ctx.deps, member.user.id, shelved);
    await recordView(ctx.deps, member.user.id, kept);
    await updateProject(ctx.deps, project.id, { archived: true });
    expect(
      ArtifactList.parse((await api.get('/artifacts/recent')).body).items.map((x) => x.id),
    ).toEqual([kept]);
  });

  test('a deleted artifact is gone', async () => {
    const { artifact } = await publish({ 'index.html': '<p>d</p>' });
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: artifact.id, expiresAt: null }],
      T,
    );
    await ctx.deps.db.db.deleteFrom('artifacts').where('id', '=', artifact.id).execute();

    const r = await api.get<ErrorJson>(`/artifacts/${artifact.id}`);
    expect(r.status).toBe(410);
    expect(r.body.error).toMatchObject({ code: 'gone', message: t('artifact.gone') });
    expect((await api.patch(`/artifacts/${artifact.id}`, { name: 'x' })).status).toBe(410);

    const unknown = await api.get<ErrorJson>('/artifacts/art_nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(t('artifact.notFound'));
    expect((await api.patch('/artifacts/art_nope', { name: 'x' })).status).toBe(404);
  });

  test('a page of summaries costs the same queries whatever its size', async () => {
    const made = [];
    for (let i = 0; i < 12; i++) {
      made.push(
        (await publish({ 'index.html': `<p>${i}</p>` }, { tags: ['a', `t${i}`] })).artifact,
      );
    }
    const queries = async (count: number): Promise<number> => {
      let seen = 0;
      const counting = ctx.deps.db.db.withPlugin({
        transformQuery: ({ node }) => {
          seen += 1;
          return node;
        },
        transformResult: async ({ result }) => result,
      });
      const deps = { ...ctx.deps, db: { ...ctx.deps.db, db: counting } };
      const rows = await ctx.deps.db.db
        .selectFrom('artifacts')
        .selectAll()
        .orderBy('id')
        .limit(count)
        .execute();
      const summaries = await toArtifactSummary(deps, rows);
      expect(summaries).toHaveLength(count);
      expect(summaries.every((s) => s.current_version !== null && s.tags.length === 2)).toBe(true);
      return seen;
    };
    const one = await queries(1);
    expect(one).toBeGreaterThan(0);
    expect(await queries(12)).toBe(one);
  });

  test('the API document describes the project, artifact and version routes', async () => {
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<string, { parameters?: { name: string; schema?: { maxLength?: number } }[] }>
      >;
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/projects',
        '/projects/{id}',
        '/artifacts',
        '/artifacts/recent',
        '/artifacts/{id}',
        '/artifacts/{id}/versions',
        '/artifacts/{id}/versions/{n}',
        '/artifacts/{id}/versions/{n}/files',
        '/artifacts/{id}/versions/{n}/restore',
      ]),
    );
    const q = doc.paths['/artifacts']?.get?.parameters?.find((p) => p.name === 'q');
    expect(q?.schema?.maxLength).toBe(256);
  });

  test('every artifact route needs a signed-in user', async () => {
    const { artifact } = await publish({ 'index.html': '<p>a</p>' });
    const anonymous = restClient(ctx, '');
    for (const r of [
      await anonymous.get('/artifacts'),
      await anonymous.get('/artifacts/recent'),
      await anonymous.get(`/artifacts/${artifact.id}`),
      await anonymous.patch(`/artifacts/${artifact.id}`, { name: 'x' }),
    ]) {
      expect(r.status).toBe(401);
    }
  });
});
