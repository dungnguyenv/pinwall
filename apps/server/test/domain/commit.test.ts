import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PublishWarning, VersionMetadata } from '../../src/content/metadata.ts';
import { searchQuery } from '../../src/db/dialect.ts';
import type { ArtifactKind, Database, UserRow } from '../../src/db/schema.ts';
import { getArtifact, getTags, normalizeTags } from '../../src/domain/artifacts.ts';
import { createProject, DEFAULT_PROJECT_ID, updateProject } from '../../src/domain/projects.ts';
import { ARTIFACT_TOPIC, reindexArtifact } from '../../src/domain/search.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import {
  type CommitResult,
  checkTarget,
  commitVersion,
  getVersionByNumber,
  type PublishTarget,
  restoreVersion,
  type VersionInput,
} from '../../src/domain/versions.ts';
import type { PinwallEvent } from '../../src/infra/event-bus.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import type { StagedFile } from '../../src/publish/stage.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { sha } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { emptyMeta, stageFiles } from '../helpers/staged.ts';

const T = Date.UTC(2026, 10, 10);
const HTML = 'text/html; charset=utf-8';

const newArtifact = (o: Partial<{ projectId: string; name: string; tags: string[] }> = {}) =>
  ({
    kind: 'new_artifact',
    projectId: o.projectId ?? null,
    name: o.name ?? null,
    tags: o.tags ?? [],
  }) satisfies PublishTarget;

const newVersion = (artifactId: string, expectedVersionId: string) =>
  ({ kind: 'new_version', artifactId, expectedVersionId }) satisfies PublishTarget;

function input(
  files: readonly StagedFile[],
  o: { meta?: VersionMetadata; entryPath?: string; kind?: ArtifactKind } = {},
): VersionInput {
  return {
    entryPath: o.entryPath ?? 'index.html',
    kind: o.kind ?? 'html',
    files,
    meta: o.meta ?? emptyMeta(),
    message: null,
    source: 'api',
  };
}

describe.each(dialects)('version commit on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let actor: UserRow;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    actor = (await createSignedInUser(ctx)).user;
  });
  afterEach(() => ctx.close());

  /** Commits `files` as `index.html`, kind html, source api. */
  async function commit(
    target: PublishTarget,
    files: Record<string, string | Buffer>,
    meta?: VersionMetadata,
  ): Promise<CommitResult> {
    return commitVersion(ctx.deps, actor, target, input(await stageFiles(ctx, files), { meta }));
  }

  const db = () => ctx.deps.db.db;
  const rows = (table: keyof Database) => db().selectFrom(table).selectAll().execute();
  const count = async (table: keyof Database) => (await rows(table)).length;
  const search = (q: string) => searchQuery(ctx.deps.db, q, 10);
  const filesOf = (versionId: string) =>
    db().selectFrom('version_files').selectAll().where('version_id', '=', versionId).execute();

  test('a first publish creates v1 in the default project', async () => {
    const { artifact, version } = await commit(newArtifact({ tags: [' Đồ Án ', 'đồ án'] }), {
      'index.html': '<h1>x</h1>',
    });

    expect(artifact).toEqual({
      id: expect.stringMatching(/^art_[0-9a-z]{20}$/),
      project_id: DEFAULT_PROJECT_ID,
      name: 'index',
      kind: 'html',
      current_version_id: version.id,
      latest_number: 1,
      created_by: actor.id,
      created_at: T,
      updated_at: T,
    });
    expect(version).toEqual({
      id: expect.stringMatching(/^ver_[0-9a-z]{20}$/),
      artifact_id: artifact.id,
      number: 1,
      parent_version_id: null,
      entry_path: 'index.html',
      title: null,
      theme_color: null,
      thumbnail_path: null,
      file_count: 1,
      total_bytes: 10,
      message: null,
      source: 'api',
      restored_from_version_id: null,
      meta: '{"warnings":[]}',
      created_by: actor.id,
      created_at: T,
    });
    expect(await getArtifact(db(), SYSTEM_SCOPE, artifact.id, T)).toEqual(artifact);
    expect(await rows('versions')).toEqual([version]);
    expect(await filesOf(version.id)).toEqual([
      {
        version_id: version.id,
        path: 'index.html',
        sha256: sha('<h1>x</h1>'),
        size: 10,
        content_type: HTML,
      },
    ]);
    expect(await getTags(db(), artifact.id)).toEqual(['đồ án']);
  });

  test('a version keeps its metadata, message and warnings', async () => {
    const files = await stageFiles(ctx, { 'index.html': '<link href="/x.css">', 'a.png': 'png' });
    const warning: PublishWarning = {
      code: 'root_absolute_url',
      file: 'index.html',
      url: '/x.css',
      message: 'm',
    };
    const { artifact, version } = await commitVersion(ctx.deps, actor, newArtifact(), {
      ...input(files, {
        meta: emptyMeta({
          title: 'Studio',
          themeColor: '#112233',
          thumbnailPath: 'a.png',
          warnings: [warning],
        }),
      }),
      message: 'First cut',
      source: 'mcp',
    });
    expect(artifact.name).toBe('Studio');
    expect(version).toMatchObject({
      title: 'Studio',
      theme_color: '#112233',
      thumbnail_path: 'a.png',
      file_count: 2,
      total_bytes: 23,
      message: 'First cut',
      source: 'mcp',
    });
    expect(JSON.parse(version.meta)).toEqual({ warnings: [warning] });
  });

  test('a new version needs the current version id', async () => {
    const v1 = await commit(newArtifact(), { 'index.html': 'one' });
    const id = v1.artifact.id;
    clock.advance(1000);
    const v2 = await commit(newVersion(id, v1.version.id), { 'index.html': 'two' });
    expect(v2.version).toMatchObject({
      artifact_id: id,
      number: 2,
      parent_version_id: v1.version.id,
      created_at: T + 1000,
    });
    expect(v2.artifact).toEqual({
      ...v1.artifact,
      current_version_id: v2.version.id,
      latest_number: 2,
      updated_at: T + 1000,
    });
    expect(await getArtifact(db(), SYSTEM_SCOPE, id, T)).toEqual(v2.artifact);

    const stale = commit(newVersion(id, v1.version.id), { 'index.html': 'three' });
    await expect(stale).rejects.toBeInstanceOf(AppError);
    await expect(stale).rejects.toMatchObject({
      code: 'version_conflict',
      status: 409,
      message: expect.stringContaining('v2'),
      details: { current_version_id: v2.version.id, current_version_number: 2 },
    });
    expect(await count('versions')).toBe(2);

    // The artifact takes the kind of its newest version.
    const md = await stageFiles(ctx, { 'index.md': '# Notes' });
    const v3 = await commitVersion(
      ctx.deps,
      actor,
      newVersion(id, v2.version.id),
      input(md, { entryPath: 'index.md', kind: 'markdown' }),
    );
    expect(v3.artifact).toMatchObject({ kind: 'markdown', latest_number: 3 });
  });

  test('two concurrent publishes on one version: exactly one wins', async () => {
    const v1 = await commit(newArtifact(), { 'index.html': 'one' });
    const target = newVersion(v1.artifact.id, v1.version.id);
    const staged = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((body) => stageFiles(ctx, { 'index.html': body })),
    );

    const results = await Promise.allSettled(
      staged.map((files) => commitVersion(ctx.deps, actor, target, input(files))),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    const winner = won[0]?.value.version;
    for (const loser of lost) {
      expect(loser.reason).toMatchObject({
        code: 'version_conflict',
        details: { current_version_id: winner?.id, current_version_number: 2 },
      });
    }
    expect(await getArtifact(db(), SYSTEM_SCOPE, v1.artifact.id, T)).toMatchObject({
      current_version_id: winner?.id,
      latest_number: 2,
    });
    expect(await count('versions')).toBe(2);
  });

  test('names default to the title, then the entry file name', async () => {
    const titled = await commit(
      newArtifact(),
      { 'index.html': 'x' },
      emptyMeta({ title: 'Báo cáo' }),
    );
    expect(titled.artifact.name).toBe('Báo cáo');

    const guide = await stageFiles(ctx, { 'docs/guide.md': '# x' });
    const fromEntry = await commitVersion(
      ctx.deps,
      actor,
      newArtifact(),
      input(guide, { entryPath: 'docs/guide.md', kind: 'markdown' }),
    );
    expect(fromEntry.artifact).toMatchObject({ name: 'guide', kind: 'markdown' });

    const named = await commit(
      newArtifact({ name: 'Q3 plan' }),
      { 'index.html': 'x' },
      emptyMeta({ title: 'Báo cáo' }),
    );
    expect(named.artifact.name).toBe('Q3 plan');

    // A blank name or title counts as none; names are cut to 200 characters, not UTF-16 units.
    const blank = await commit(
      newArtifact({ name: '  ' }),
      { 'index.html': 'x' },
      emptyMeta({ title: '😀'.repeat(250) }),
    );
    expect(blank.artifact.name).toBe('😀'.repeat(200));
  });

  test('an archived or unknown project refuses new artifacts', async () => {
    const project = await createProject(ctx.deps, actor, { name: 'Old site' });
    await updateProject(ctx.deps, SYSTEM_SCOPE, project.id, { archived: true });
    await expect(
      commit(newArtifact({ projectId: project.id }), { 'index.html': 'x' }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409, message: t('project.archived') });
    await expect(
      commit(newArtifact({ projectId: 'prj_nope' }), { 'index.html': 'x' }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404, message: t('project.notFound') });
    expect(await count('artifacts')).toBe(0);

    await updateProject(ctx.deps, SYSTEM_SCOPE, project.id, { archived: false });
    const { artifact } = await commit(newArtifact({ projectId: project.id }), {
      'index.html': 'x',
    });
    expect(artifact.project_id).toBe(project.id);
  });

  test('checkTarget validates without writing', async () => {
    await expect(checkTarget(ctx.deps, SYSTEM_SCOPE, newArtifact())).resolves.toBeUndefined();
    expect(await count('projects')).toBe(0);

    const v1 = await commit(newArtifact(), { 'index.html': 'one' });
    const id = v1.artifact.id;
    const v2 = await commit(newVersion(id, v1.version.id), { 'index.html': 'two' });

    await expect(
      checkTarget(ctx.deps, SYSTEM_SCOPE, newVersion(id, v1.version.id)),
    ).rejects.toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: v2.version.id, current_version_number: 2 },
    });
    await expect(
      checkTarget(ctx.deps, SYSTEM_SCOPE, newVersion(id, v2.version.id)),
    ).resolves.toBeUndefined();
    await expect(
      checkTarget(ctx.deps, SYSTEM_SCOPE, newVersion('art_nope', v2.version.id)),
    ).rejects.toMatchObject({ status: 404, message: t('artifact.notFound') });
    await expect(
      checkTarget(ctx.deps, SYSTEM_SCOPE, newArtifact({ projectId: 'prj_nope' })),
    ).rejects.toMatchObject({ status: 404, message: t('project.notFound') });
    await expect(
      checkTarget(ctx.deps, SYSTEM_SCOPE, newArtifact({ tags: ['x'.repeat(41)] })),
    ).rejects.toMatchObject({ status: 400, details: { field: 'tags' } });

    expect(await count('artifacts')).toBe(1);
    expect(await count('versions')).toBe(2);
  });

  test('publishing indexes search in the same transaction and emits version.published', async () => {
    const publish = vi.spyOn(ctx.deps.events, 'publish');
    const { artifact, version } = await commit(
      newArtifact({ tags: ['Ảnh cưới'] }),
      { 'index.html': 'x' },
      emptyMeta({ title: 'Studio', text: 'Dịch vụ chụp ảnh' }),
    );
    expect(await search('chup anh')).toEqual([artifact.id]);
    expect(await search('anh cuoi')).toEqual([artifact.id]);
    expect(await search('studio')).toEqual([artifact.id]);
    expect(publish).toHaveBeenCalledExactlyOnceWith(ARTIFACT_TOPIC(artifact.id), {
      type: 'version.published',
      artifact_id: artifact.id,
      version_id: version.id,
      number: 1,
    });

    const heard: PinwallEvent[] = [];
    ctx.deps.events.subscribe(ARTIFACT_TOPIC(artifact.id), (event) => heard.push(event));
    const v2 = await commit(
      newVersion(artifact.id, version.id),
      { 'index.html': 'y' },
      emptyMeta({ text: 'Bảng giá' }),
    );
    expect(heard).toEqual([
      { type: 'version.published', artifact_id: artifact.id, version_id: v2.version.id, number: 2 },
    ]);
    expect(await search('chup anh')).toEqual([]);
    expect(await search('bang gia')).toEqual([artifact.id]);
  });

  test('a failed commit writes nothing and announces nothing', async () => {
    const publish = vi.spyOn(ctx.deps.events, 'publish');
    const files = await stageFiles(ctx, { 'index.html': 'one' });
    // The same path twice breaks the version_files key after the artifact and version rows.
    await expect(
      commitVersion(
        ctx.deps,
        actor,
        newArtifact({ tags: ['x'] }),
        input([...files, ...files], { meta: emptyMeta({ text: 'chụp ảnh' }) }),
      ),
    ).rejects.toThrow();
    for (const table of ['artifacts', 'artifact_tags', 'versions', 'version_files'] as const) {
      expect(await rows(table)).toEqual([]);
    }
    expect(await search('chup anh')).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  test('restore copies an old version into a new one', async () => {
    const warning: PublishWarning = {
      code: 'root_absolute_url',
      file: 'index.html',
      url: '/a',
      message: 'm',
    };
    const v1 = await commit(
      newArtifact(),
      { 'index.html': 'one' },
      emptyMeta({ title: 'First', themeColor: '#123456', warnings: [warning] }),
    );
    const id = v1.artifact.id;
    const v2 = await commit(
      newVersion(id, v1.version.id),
      { 'index.html': 'two', 'extra.css': 'b{}' },
      emptyMeta({ title: 'Second', text: 'two' }),
    );
    const blobs = await count('blobs');
    const publish = vi.spyOn(ctx.deps.events, 'publish');
    clock.advance(1000);

    const { artifact, version } = await restoreVersion(ctx.deps, actor, id, 1, v2.version.id);
    expect(version).toEqual({
      id: expect.stringMatching(/^ver_[0-9a-z]{20}$/),
      artifact_id: id,
      number: 3,
      parent_version_id: v2.version.id,
      entry_path: 'index.html',
      title: 'First',
      theme_color: '#123456',
      thumbnail_path: null,
      file_count: 1,
      total_bytes: 3,
      message: 'Restored from v1',
      source: 'restore',
      restored_from_version_id: v1.version.id,
      meta: v1.version.meta,
      created_by: actor.id,
      created_at: T + 1000,
    });
    expect(artifact).toEqual({
      ...v2.artifact,
      current_version_id: version.id,
      latest_number: 3,
      updated_at: T + 1000,
    });
    expect(await getArtifact(db(), SYSTEM_SCOPE, id, T)).toEqual(artifact);
    expect(await filesOf(version.id)).toEqual([
      {
        version_id: version.id,
        path: 'index.html',
        sha256: sha('one'),
        size: 3,
        content_type: HTML,
      },
    ]);
    expect(await count('blobs')).toBe(blobs);
    // The search text is v1's, read from its files.
    expect(await search('one')).toEqual([id]);
    expect(await search('two')).toEqual([]);
    expect(publish).toHaveBeenCalledExactlyOnceWith(ARTIFACT_TOPIC(id), {
      type: 'version.published',
      artifact_id: id,
      version_id: version.id,
      number: 3,
    });

    await expect(restoreVersion(ctx.deps, actor, id, 1, v2.version.id)).rejects.toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: version.id, current_version_number: 3 },
    });
    expect(await count('versions')).toBe(3);
  });

  test('restoring a Markdown version makes the artifact Markdown again', async () => {
    const md = await stageFiles(ctx, { 'index.md': '# Ghi chú' });
    const v1 = await commitVersion(
      ctx.deps,
      actor,
      newArtifact(),
      input(md, { entryPath: 'index.md', kind: 'markdown' }),
    );
    const v2 = await commit(newVersion(v1.artifact.id, v1.version.id), { 'index.html': 'x' });
    expect(v2.artifact.kind).toBe('html');
    const v3 = await restoreVersion(ctx.deps, actor, v1.artifact.id, 1, v2.version.id);
    expect(v3.artifact.kind).toBe('markdown');
    expect(v3.version.entry_path).toBe('index.md');
    expect(await search('ghi chu')).toEqual([v1.artifact.id]);
  });

  test('a missing version number is gone or not found', async () => {
    const v1 = await commit(newArtifact(), { 'index.html': 'one' });
    const id = v1.artifact.id;
    const v2 = await commit(newVersion(id, v1.version.id), { 'index.html': 'two' });
    await db().deleteFrom('versions').where('id', '=', v1.version.id).execute();
    const artifact = await getArtifact(db(), SYSTEM_SCOPE, id, T);

    const gone = { code: 'gone', status: 410, message: t('version.gone') };
    const notFound = { code: 'not_found', status: 404, message: t('version.notFound') };
    await expect(getVersionByNumber(db(), artifact, 1)).rejects.toMatchObject(gone);
    await expect(getVersionByNumber(db(), artifact, 5)).rejects.toMatchObject(notFound);
    await expect(getVersionByNumber(db(), artifact, 0)).rejects.toMatchObject(notFound);
    expect(await getVersionByNumber(db(), artifact, 2)).toEqual(v2.version);
    await expect(restoreVersion(ctx.deps, actor, id, 1, v2.version.id)).rejects.toMatchObject(gone);
    await expect(restoreVersion(ctx.deps, actor, id, 3, v2.version.id)).rejects.toMatchObject(
      notFound,
    );
  });

  test('a deleted artifact is gone, an unknown one not found', async () => {
    await addTombstones(db(), [{ kind: 'artifact', key: 'art_deleted', expiresAt: null }], T);
    const gone = { code: 'gone', status: 410, message: t('artifact.gone') };
    const notFound = { code: 'not_found', status: 404, message: t('artifact.notFound') };
    await expect(getArtifact(db(), SYSTEM_SCOPE, 'art_deleted', T)).rejects.toMatchObject(gone);
    await expect(getArtifact(db(), SYSTEM_SCOPE, 'art_unknown', T)).rejects.toMatchObject(notFound);
    await expect(
      commit(newVersion('art_deleted', 'ver_x'), { 'index.html': 'x' }),
    ).rejects.toMatchObject(gone);
    await expect(
      commit(newVersion('art_unknown', 'ver_x'), { 'index.html': 'x' }),
    ).rejects.toMatchObject(notFound);
    await expect(restoreVersion(ctx.deps, actor, 'art_deleted', 1, 'ver_x')).rejects.toMatchObject(
      gone,
    );
  });

  test('reindexArtifact reads the current version and drops what has none', async () => {
    const { artifact } = await commit(newArtifact(), { 'index.html': '<p>Chụp ảnh</p>' });
    // The commit indexed the text it was given, which was none.
    expect(await search('chup anh')).toEqual([]);

    await db()
      .updateTable('artifacts')
      .set({ name: 'Bảng giá' })
      .where('id', '=', artifact.id)
      .execute();
    await db()
      .insertInto('artifact_tags')
      .values({ artifact_id: artifact.id, tag: 'cưới' })
      .execute();
    await reindexArtifact(ctx.deps, artifact.id);
    expect(await search('chup anh')).toEqual([artifact.id]);
    expect(await search('bang gia')).toEqual([artifact.id]);
    expect(await search('cuoi')).toEqual([artifact.id]);

    await db()
      .updateTable('artifacts')
      .set({ current_version_id: null })
      .where('id', '=', artifact.id)
      .execute();
    await reindexArtifact(ctx.deps, artifact.id);
    expect(await search('chup anh')).toEqual([]);
    // An artifact that does not exist is simply not indexed.
    await expect(reindexArtifact(ctx.deps, 'art_unknown')).resolves.toBeUndefined();
  });
});

describe('normalizeTags', () => {
  const badTags = { code: 'bad_request', status: 400, message: t('artifact.badTags') };

  test('folds case, normalization and spacing, then deduplicates and sorts', () => {
    expect(normalizeTags([' Đồ   Án ', 'đồ án'.normalize('NFD'), 'B', 'a', 'x\ty\u0000z'])).toEqual(
      ['a', 'b', 'x y z', 'đồ án'],
    );
    expect(normalizeTags([])).toEqual([]);
  });

  test('takes at most 20 tags of 1 to 40 characters', () => {
    expect(normalizeTags(['x'.repeat(40), '😀'.repeat(40)])).toEqual([
      'x'.repeat(40),
      '😀'.repeat(40),
    ]);
    const twenty = Array.from({ length: 20 }, (_, i) => `tag ${i}`);
    expect(normalizeTags([...twenty, 'TAG 0'])).toHaveLength(20);

    for (const tags of [['x'.repeat(41)], [''], ['   '], [...twenty, 'tag 20']]) {
      expect(() => normalizeTags(tags)).toThrow(AppError);
      try {
        normalizeTags(tags);
      } catch (error) {
        expect(error).toMatchObject({ ...badTags, details: { field: 'tags' } });
      }
    }
  });
});
