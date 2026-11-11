import { ArtifactList, ArtifactSummary } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthContext } from '../../src/app.ts';
import { createGrant } from '../../src/content/grants.ts';
import type { TombstoneKind, UserRow, VersionRow } from '../../src/db/schema.ts';
import type { AppDeps } from '../../src/deps.ts';
import { BACKUP_LEASE, sweepBlobs } from '../../src/domain/blobs.ts';
import { deleteVersion } from '../../src/domain/deletion.ts';
import { DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { ARTIFACT_TOPIC } from '../../src/domain/search.ts';
import { addTombstones, isTombstoned } from '../../src/domain/tombstones.ts';
import type { PinwallEvent, Scheduler } from '../../src/infra/index.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { newContentToken, newId } from '../../src/lib/ids.ts';
import type { PublishOutcome } from '../../src/publish/ingest.ts';
import { startPublishing } from '../../src/publish/startup.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { blobState, sha, storeBlob } from '../helpers/blobs.ts';
import { fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

describe.each(dialects)('deletion on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  /** A member, who publishes everything below. */
  let publisher: { user: UserRow; cookie: string };
  let api: ReturnType<typeof restClient>;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    publisher = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    api = restClient(ctx, publisher.cookie);
  });
  afterEach(() => ctx.close());

  const asPublisher = (): AuthContext => ({ user: publisher.user, via: 'session' });

  /** Publishes `files` as a new artifact, or on top of `after` when given. */
  async function publish(
    files: Record<string, string>,
    after?: PublishOutcome,
    tags: string[] = [],
  ): Promise<PublishOutcome> {
    clock.advance(1000);
    return publishFiles(
      ctx,
      publisher.user,
      files,
      after === undefined
        ? { kind: 'new_artifact', projectId: null, name: null, tags }
        : {
            kind: 'new_version',
            artifactId: after.artifact.id,
            expectedVersionId: after.version.id,
          },
    );
  }

  /** A link as the publisher's browser session opens it, without following redirects. */
  const open = (path: string) =>
    ctx.request(path, { headers: { cookie: publisher.cookie }, redirect: 'manual' });

  async function search(q: string): Promise<string[]> {
    const r = await api.get(`/artifacts?q=${encodeURIComponent(q)}`);
    expect(r.status).toBe(200);
    return ArtifactList.parse(r.body).items.map((a) => a.id);
  }

  const tombstoned = (kind: TombstoneKind, key: string) =>
    isTombstoned(ctx.deps.db.db, kind, key, clock.now());

  /** The events published on the artifact's topic from now on. */
  function eventsOf(artifactId: string): PinwallEvent[] {
    const events: PinwallEvent[] = [];
    ctx.deps.events.subscribe(ARTIFACT_TOPIC(artifactId), (e) => events.push(e));
    return events;
  }

  async function insertShareLink(
    artifactId: string,
    versionId: string | null,
  ): Promise<{ id: string; hash: string }> {
    const id = newId('shr');
    const hash = sha(`share ${id}`);
    await ctx.deps.db.db
      .insertInto('share_links')
      .values({
        id,
        artifact_id: artifactId,
        version_id: versionId,
        token_hash: hash,
        password_hash: null,
        allow_comments: 1,
        expires_at: null,
        created_by: publisher.user.id,
        created_at: clock.now(),
        last_used_at: null,
        revoked_at: null,
      })
      .execute();
    return { id, hash };
  }

  /** A comment on `version`: a thread root, or a reply to `parentId`. */
  async function insertComment(
    version: VersionRow,
    o: { parentId?: string; resolvedIn?: string } = {},
  ): Promise<string> {
    const id = newId('cmt');
    const root = o.parentId === undefined;
    await ctx.deps.db.db
      .insertInto('comments')
      .values({
        id,
        artifact_id: version.artifact_id,
        version_id: version.id,
        parent_id: o.parentId ?? null,
        author_user_id: publisher.user.id,
        guest_name: null,
        share_link_id: null,
        body: `comment ${id}`,
        anchor: root ? '{}' : null,
        status: root ? (o.resolvedIn === undefined ? 'open' : 'resolved') : null,
        resolved_in_version_id: o.resolvedIn ?? null,
        resolved_by: o.resolvedIn === undefined ? null : publisher.user.id,
        resolved_at: o.resolvedIn === undefined ? null : clock.now(),
        created_at: clock.now(),
        updated_at: clock.now(),
        edited_at: null,
      })
      .execute();
    return id;
  }

  async function rowsOf(table: 'share_links' | 'comments', artifactId: string) {
    return ctx.deps.db.db
      .selectFrom(table)
      .select('id')
      .where('artifact_id', '=', artifactId)
      .orderBy('id')
      .execute()
      .then((rows) => rows.map((row) => row.id));
  }

  test('deleting a version with a secret: links gone at once, files removed unless shared', async () => {
    const v1 = await publish({
      'index.html': 'one',
      'secret.txt': 'sk-live-123',
      'shared.css': 'body{}',
    });
    await publish({ 'index.html': 'two', 'shared.css': 'body{}' }, v1);
    const id = v1.artifact.id;
    const grant1 = await createGrant(ctx.deps, {
      versionId: v1.version.id,
      mode: 'raw',
      user: publisher.user,
    });
    expect(await (await fetchContent(ctx, grant1.token, 'secret.txt')).text()).toBe('sk-live-123');

    const r = await api.del(`/artifacts/${id}/versions/1`);
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();

    expect((await open(`/a/${id}/v/1/raw`)).status).toBe(410);
    expect((await fetchContent(ctx, grant1.token, 'secret.txt')).status).toBe(410);
    expect((await fetchContent(ctx, grant1.token, '')).status).toBe(410);
    const version = await api.get(`/artifacts/${id}/versions/1`);
    expect(version.status).toBe(410);
    expect((version.body as ErrorJson).error.message).toBe(t('version.gone'));
    expect(await tombstoned('content_grant', grant1.token)).toBe(true);

    expect(await blobState(ctx.deps, sha('sk-live-123'))).toEqual({ row: false, object: false });
    expect(await blobState(ctx.deps, sha('one'))).toEqual({ row: false, object: false });
    expect(await blobState(ctx.deps, sha('body{}'))).toEqual({ row: true, object: true });

    const raw = await open(`/a/${id}/raw`);
    expect(raw.status).toBe(302);
    const current = await ctx.request(raw.headers.get('location') ?? '');
    expect(await current.text()).toBe('two');
    expect((await open(`/a/${id}/v/2/raw`)).status).toBe(302);
  });

  test('deleting the current version makes the previous one current', async () => {
    const v1 = await publish({ 'index.md': '# Plan\n\nDịch vụ chụp ảnh' });
    await publish({ 'index.html': '<p>other words</p>' }, v1);
    const id = v1.artifact.id;
    expect(await search('chup anh')).toEqual([]);
    expect(await search('other')).toEqual([id]);
    const events = eventsOf(id);

    clock.advance(1000);
    expect(await deleteVersion(ctx.deps, asPublisher(), id, 2)).toEqual({
      artifactDeleted: false,
      currentVersionId: v1.version.id,
    });
    expect(events).toEqual([{ type: 'version.deleted', artifact_id: id, number: 2 }]);

    const artifact = ArtifactSummary.parse((await api.get(`/artifacts/${id}`)).body);
    expect(artifact.current_version?.id).toBe(v1.version.id);
    expect(artifact.kind).toBe('markdown');
    expect(artifact.latest_number).toBe(2);
    expect(artifact.updated_at).toBe(clock.now());
    expect(await search('chup anh')).toEqual([id]);
    expect(await search('other')).toEqual([]);
    expect(await blobState(ctx.deps, sha('<p>other words</p>'))).toEqual({
      row: false,
      object: false,
    });

    // The number of the deleted version is never given again.
    const v3 = await publish({ 'index.html': '<p>three</p>' }, v1);
    expect(v3.version.number).toBe(3);
    expect(v3.version.parent_version_id).toBe(v1.version.id);
    expect((await api.get(`/artifacts/${id}/versions/2`)).status).toBe(410);
  });

  test('deleting an older version leaves the current one and the index alone', async () => {
    const v1 = await publish({ 'index.html': '<p>first draft</p>' });
    const v2 = await publish({ 'index.html': '<p>final copy</p>' }, v1);
    const id = v1.artifact.id;
    const before = ArtifactSummary.parse((await api.get(`/artifacts/${id}`)).body);

    clock.advance(1000);
    expect(await deleteVersion(ctx.deps, asPublisher(), id, 1)).toEqual({
      artifactDeleted: false,
      currentVersionId: v2.version.id,
    });
    expect(ArtifactSummary.parse((await api.get(`/artifacts/${id}`)).body)).toEqual(before);
    expect(await search('final')).toEqual([id]);

    // Deleting it again: it is gone.
    const again = await api.del(`/artifacts/${id}/versions/1`);
    expect(again.status).toBe(410);
    expect((again.body as ErrorJson).error.message).toBe(t('version.gone'));
    expect((await api.del(`/artifacts/${id}/versions/3`)).status).toBe(404);
  });

  test('a version that becomes current while the delete reads is indexed after commit', async () => {
    const v1 = await publish({ 'index.html': '<p>alpha words</p>' });
    const v2 = await publish({ 'index.html': '<p>beta words</p>' }, v1);
    await publish({ 'index.html': '<p>gamma words</p>' }, v2);
    const id = v1.artifact.id;
    // While deleting v3 reads the text of v2, its expected successor, v2 is deleted too.
    const get = ctx.deps.blobs.get.bind(ctx.deps.blobs);
    let raced = false;
    vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (key, range) => {
      if (!raced) {
        raced = true;
        await deleteVersion(ctx.deps, asPublisher(), id, 2);
      }
      return get(key, range);
    });

    expect(await deleteVersion(ctx.deps, asPublisher(), id, 3)).toEqual({
      artifactDeleted: false,
      currentVersionId: v1.version.id,
    });
    expect(raced).toBe(true);
    expect(await search('alpha')).toEqual([id]);
    expect(await search('beta')).toEqual([]);
    expect(await search('gamma')).toEqual([]);
  });

  test('deleting the last version deletes the artifact', async () => {
    const v1 = await publish({ 'index.html': '<p>only page</p>' }, undefined, ['solo']);
    const id = v1.artifact.id;
    const events = eventsOf(id);

    expect(await deleteVersion(ctx.deps, asPublisher(), id, 1)).toEqual({
      artifactDeleted: true,
      currentVersionId: null,
    });
    expect(events).toEqual([{ type: 'artifact.deleted', artifact_id: id }]);

    const r = await api.get(`/artifacts/${id}`);
    expect(r.status).toBe(410);
    expect((r.body as ErrorJson).error.message).toBe(t('artifact.gone'));
    expect((await open(`/a/${id}/raw`)).status).toBe(410);
    expect((await open(`/a/${id}/v/1/raw`)).status).toBe(410);
    expect(await search('only page')).toEqual([]);
    expect(await search('solo')).toEqual([]);
    expect(await tombstoned('artifact', id)).toBe(true);
    expect(await blobState(ctx.deps, sha('<p>only page</p>'))).toEqual({
      row: false,
      object: false,
    });
    const tags = await ctx.deps.db.db.selectFrom('artifact_tags').selectAll().execute();
    expect(tags).toEqual([]);
  });

  test('deleting an artifact cascades and tombstones its share links', async () => {
    const v1 = await publish(
      { 'index.html': '<p>to delete</p>', 'shared.css': 'body{}' },
      undefined,
      ['doomed'],
    );
    const v2 = await publish({ 'index.html': '<p>to delete too</p>', 'shared.css': 'body{}' }, v1);
    const other = await publish({ 'index.html': '<p>keeper</p>', 'shared.css': 'body{}' });
    const id = v1.artifact.id;
    const wide = await insertShareLink(id, null);
    const perVersion = await insertShareLink(id, v1.version.id);
    const root = await insertComment(v1.version);
    await insertComment(v1.version, { parentId: root });
    await api.get(`/artifacts/${id}/versions/1/preview`);
    const grants = await Promise.all(
      [v1, v2].map((v) =>
        createGrant(ctx.deps, { versionId: v.version.id, mode: 'review', user: publisher.user }),
      ),
    );
    // An expired grant answers "expired" until the cleanup removes it; it needs no tombstone.
    const expired = await createGrant(ctx.deps, {
      versionId: v1.version.id,
      mode: 'raw',
      user: publisher.user,
      ttlMs: 1,
    });
    clock.advance(10);
    const events = eventsOf(id);

    const r = await api.del(`/artifacts/${id}`);
    expect(r.status).toBe(204);
    expect(events).toEqual([{ type: 'artifact.deleted', artifact_id: id }]);

    const { db } = ctx.deps.db;
    expect(await rowsOf('share_links', id)).toEqual([]);
    expect(await rowsOf('comments', id)).toEqual([]);
    for (const table of ['artifact_tags', 'artifact_views', 'versions'] as const) {
      const rows = await db.selectFrom(table).select('artifact_id').where('artifact_id', '=', id);
      expect(await rows.execute(), table).toEqual([]);
    }
    const files = await db
      .selectFrom('version_files')
      .select('version_id')
      .where('version_id', 'in', [v1.version.id, v2.version.id])
      .execute();
    expect(files).toEqual([]);
    expect(await db.selectFrom('content_grants').selectAll().execute()).toEqual([]);

    expect(await tombstoned('artifact', id)).toBe(true);
    expect(await tombstoned('share_link', wide.hash)).toBe(true);
    expect(await tombstoned('share_link', perVersion.hash)).toBe(true);
    for (const grant of grants) {
      expect(await tombstoned('content_grant', grant.token)).toBe(true);
      expect((await fetchContent(ctx, grant.token, '')).status).toBe(410);
    }
    expect(await tombstoned('content_grant', expired.token)).toBe(false);
    expect((await api.get(`/artifacts/${id}`)).status).toBe(410);
    expect((await api.del(`/artifacts/${id}`)).status).toBe(410);
    expect(await search('doomed')).toEqual([]);

    expect(await blobState(ctx.deps, sha('<p>to delete</p>'))).toEqual({
      row: false,
      object: false,
    });
    expect(await blobState(ctx.deps, sha('body{}'))).toEqual({ row: true, object: true });
    expect(await search('keeper')).toEqual([other.artifact.id]);
  });

  test('deleting a version removes its comment threads and per-version share links only', async () => {
    const v1 = await publish({ 'index.html': '<p>1</p>' });
    const v2 = await publish({ 'index.html': '<p>2</p>' }, v1);
    const v3 = await publish({ 'index.html': '<p>3</p>' }, v2);
    const id = v1.artifact.id;
    const onV1 = await insertComment(v1.version);
    const onV2 = await insertComment(v2.version);
    await insertComment(v2.version, { parentId: onV2 });
    const onV3 = await insertComment(v3.version);
    // Written on v1 and resolved in v2: the thread stays, without the version it named.
    const resolvedInV2 = await insertComment(v1.version, { resolvedIn: v2.version.id });
    const wide = await insertShareLink(id, null);
    const linkV1 = await insertShareLink(id, v1.version.id);
    const linkV2 = await insertShareLink(id, v2.version.id);

    expect((await api.del(`/artifacts/${id}/versions/2`)).status).toBe(204);

    expect(await rowsOf('comments', id)).toEqual([onV1, onV3, resolvedInV2].sort());
    const resolved = await ctx.deps.db.db
      .selectFrom('comments')
      .selectAll()
      .where('id', '=', resolvedInV2)
      .executeTakeFirstOrThrow();
    expect(resolved).toMatchObject({ status: 'resolved', resolved_in_version_id: null });
    expect(await rowsOf('share_links', id)).toEqual([wide.id, linkV1.id].sort());
    expect(await tombstoned('share_link', linkV2.hash)).toBe(true);
    expect(await tombstoned('share_link', linkV1.hash)).toBe(false);
    expect(await tombstoned('share_link', wide.hash)).toBe(false);
  });

  test('only an admin or the publisher can delete', async () => {
    const mine = await publish({ 'index.html': '<p>mine</p>' });
    await publish({ 'index.html': '<p>second</p>' }, mine);
    const other = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });
    const otherApi = restClient(ctx, other.cookie);
    const id = mine.artifact.id;

    for (const path of [`/artifacts/${id}/versions/1`, `/artifacts/${id}`]) {
      const r = await otherApi.del(path);
      expect(r.status, path).toBe(403);
      expect((r.body as ErrorJson).error).toEqual({
        code: 'forbidden',
        message: t('artifact.deleteForbidden'),
      });
    }
    const anonymous = await ctx.request(`/api/v1/artifacts/${id}`, {
      method: 'DELETE',
      headers: { origin: ctx.deps.config.publicOrigin },
    });
    expect(anonymous.status).toBe(401);
    const versions = await ctx.deps.db.db
      .selectFrom('versions')
      .select('number')
      .where('artifact_id', '=', id)
      .execute();
    expect(versions).toHaveLength(2);

    expect((await api.del(`/artifacts/${id}/versions/1`)).status).toBe(204);

    const admin = await createSignedInUser(ctx, { kind: 'oidc', idpRole: 'admin', name: 'Hoa' });
    expect((await restClient(ctx, admin.cookie).del(`/artifacts/${id}`)).status).toBe(204);
    expect((await api.get(`/artifacts/${id}`)).status).toBe(410);

    // The owner is an admin too.
    const owned = await publish({ 'index.html': '<p>owned</p>' });
    const owner = await createSignedInUser(ctx);
    const ownerApi = restClient(ctx, owner.cookie);
    expect((await ownerApi.del(`/artifacts/${owned.artifact.id}/versions/1`)).status).toBe(204);
  });

  test('a version deleted during a backup keeps its files until the sweep', async () => {
    const v1 = await publish({ 'index.html': '<p>one</p>', 'secret.txt': 'sk-live-456' });
    await publish({ 'index.html': '<p>two</p>' }, v1);
    const id = v1.artifact.id;
    const grant = await createGrant(ctx.deps, {
      versionId: v1.version.id,
      mode: 'raw',
      user: publisher.user,
    });
    expect(await ctx.deps.leases.acquire(BACKUP_LEASE, 'b', 60_000)).toBe(true);

    expect((await api.del(`/artifacts/${id}/versions/1`)).status).toBe(204);
    expect((await fetchContent(ctx, grant.token, 'secret.txt')).status).toBe(410);
    expect((await open(`/a/${id}/v/1/raw`)).status).toBe(410);
    expect(await blobState(ctx.deps, sha('sk-live-456'))).toEqual({ row: true, object: true });
    expect(await sweepBlobs(ctx.deps)).toBe(0);

    await ctx.deps.leases.release(BACKUP_LEASE, 'b');
    expect(await sweepBlobs(ctx.deps)).toBe(2);
    expect(await blobState(ctx.deps, sha('sk-live-456'))).toEqual({ row: false, object: false });
    expect(await blobState(ctx.deps, sha('<p>one</p>'))).toEqual({ row: false, object: false });
  });

  test('startPublishing creates the default project and schedules the jobs', async () => {
    const jobs = new Map<string, { intervalMs: number; fn: () => Promise<void> }>();
    const scheduler: Scheduler = {
      every: (name, intervalMs, fn) => {
        jobs.set(name, { intervalMs, fn });
      },
      stop: async () => {},
    };
    const deps: AppDeps = { ...ctx.deps, scheduler };
    expect(
      await ctx.deps.db.db.selectFrom('projects').select('id').execute(),
      'no project before',
    ).toEqual([]);

    await startPublishing(deps);
    expect(await ctx.deps.db.db.selectFrom('projects').select('id').execute()).toEqual([
      { id: DEFAULT_PROJECT_ID },
    ]);
    expect([...jobs.keys()]).toEqual(['content-cleanup', 'blob-sweep']);
    expect(jobs.get('content-cleanup')?.intervalMs).toBe(3_600_000);
    expect(jobs.get('blob-sweep')?.intervalMs).toBe(600_000);

    // content-cleanup removes expired grants and expired tombstones.
    const { version } = await publish({ 'index.html': '<p>x</p>' });
    const live = await createGrant(ctx.deps, {
      versionId: version.id,
      mode: 'raw',
      user: publisher.user,
    });
    await createGrant(ctx.deps, {
      versionId: version.id,
      mode: 'raw',
      user: publisher.user,
      ttlMs: 5,
    });
    const token = newContentToken();
    await addTombstones(
      ctx.deps.db.db,
      [
        { kind: 'content_grant', key: token, expiresAt: clock.now() + 5 },
        { kind: 'artifact', key: 'art_kept', expiresAt: null },
      ],
      clock.now(),
    );
    clock.advance(10);
    await jobs.get('content-cleanup')?.fn();
    const grants = await ctx.deps.db.db.selectFrom('content_grants').select('token').execute();
    expect(grants).toEqual([{ token: live.token }]);
    const left = await ctx.deps.db.db.selectFrom('tombstones').select('key').execute();
    expect(left).toEqual([{ key: 'art_kept' }]);

    // blob-sweep removes blobs no version references.
    const orphan = await storeBlob(ctx.deps, 'orphan bytes');
    await jobs.get('blob-sweep')?.fn();
    expect(await blobState(ctx.deps, orphan)).toEqual({ row: false, object: false });

    // Running it again changes nothing.
    await startPublishing({ ...ctx.deps, scheduler: { ...scheduler, every: () => {} } });
    expect(await ctx.deps.db.db.selectFrom('projects').select('id').execute()).toHaveLength(1);
  });
});
