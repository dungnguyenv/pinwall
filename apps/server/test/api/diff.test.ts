import { randomBytes } from 'node:crypto';
import { MarkdownDiff, TextFileDiff, VersionDiff } from '@pinwall/shared';
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

describe.each(dialects)('diffs over REST on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };
  let api: ReturnType<typeof restClient>;
  let id: string;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    api = restClient(ctx, member.cookie);
    const first = await publishFiles(ctx, member.user, {
      'index.html': '<p>one</p>',
      'a.txt': '1\n2\n3\n',
      'gone.txt': 'bye\n',
      'doc.md': '# T\n\nA\n\nB\n',
    });
    clock.advance(1000);
    await publishFiles(
      ctx,
      member.user,
      {
        'index.html': '<p>two</p>',
        'a.txt': '1\n22\n3\n',
        'added.txt': 'hi\n',
        'doc.md': '# T\n\nA\n\nB2\n\nC\n',
      },
      { kind: 'new_version', artifactId: first.artifact.id, expectedVersionId: first.version.id },
    );
    id = first.artifact.id;
  });
  afterEach(() => ctx.close());

  const message = (body: unknown) => (body as ErrorJson).error.message;

  test('lists the changed files', async () => {
    const r = await api.get(`/artifacts/${id}/diff?from=1&to=2`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const diff = VersionDiff.parse(r.body);
    expect(diff.from).toBe(1);
    expect(diff.to).toBe(2);
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'],
      ['added.txt', 'added'],
      ['doc.md', 'modified'],
      ['gone.txt', 'removed'],
      ['index.html', 'modified'],
    ]);
    expect(diff.files[0]?.old?.sha256).toBe(sha('1\n2\n3\n'));
    expect(diff.files[1]?.old).toBeNull();
    expect(diff.files[3]?.new).toBeNull();
    expect(
      VersionDiff.parse((await api.get(`/artifacts/${id}/diff?from=2&to=2`)).body).files,
    ).toEqual([]);
  });

  test('returns the unified diff of a file', async () => {
    const r = await api.get(`/artifacts/${id}/diff/file?from=1&to=2&path=a.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const diff = TextFileDiff.parse(r.body);
    expect(diff).toMatchObject({ path: 'a.txt', binary: false, too_large: false });
    expect(diff.patch).toContain('--- a.txt\tv1\n+++ a.txt\tv2\n');
    expect(diff.patch).toContain('\n-2\n+22\n');
    // A path with a directory, percent-encoded as a client sends it.
    const added = await api.get(
      `/artifacts/${id}/diff/file?from=1&to=2&path=${encodeURIComponent('added.txt')}`,
    );
    expect(TextFileDiff.parse(added.body).old).toBeNull();
    const html = await api.get(`/artifacts/${id}/diff/file?from=1&to=2&path=index.html`);
    expect(TextFileDiff.parse(html.body).patch).toContain(
      '-<p>one</p>\n\\ No newline at end of file',
    );
  });

  test('files too big or too unlike to compare are answered quickly, without a patch', async () => {
    const random = () =>
      `${Array.from({ length: 25_000 }, () => randomBytes(8).toString('hex')).join('\n')}\n`;
    clock.advance(1000);
    const first = await publishFiles(ctx, member.user, {
      'index.html': '<p>x</p>',
      'r.txt': random(),
    });
    clock.advance(1000);
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>x</p>', 'r.txt': random(), 'big.txt': 'x'.repeat(1_000_001) },
      { kind: 'new_version', artifactId: first.artifact.id, expectedVersionId: first.version.id },
    );
    const started = performance.now();
    const unlike = await api.get(
      `/artifacts/${first.artifact.id}/diff/file?from=1&to=2&path=r.txt`,
    );
    const big = await api.get(`/artifacts/${first.artifact.id}/diff/file?from=1&to=2&path=big.txt`);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(TextFileDiff.parse(unlike.body)).toMatchObject({
      binary: false,
      too_large: true,
      patch: null,
    });
    expect(TextFileDiff.parse(big.body)).toMatchObject({
      binary: false,
      too_large: true,
      patch: null,
    });
  });

  test('returns the rendered Markdown diff of a file', async () => {
    const r = await api.get(`/artifacts/${id}/diff/markdown?from=1&to=2&path=doc.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const diff = MarkdownDiff.parse(r.body);
    expect(diff.path).toBe('doc.md');
    expect(diff.too_large).toBe(false);
    expect(diff.blocks.map((b) => b.op)).toEqual(['unchanged', 'unchanged', 'changed', 'added']);
    expect(diff.blocks[2]).toEqual({
      op: 'changed',
      old_html: '<p>B</p>\n',
      new_html: '<p>B2</p>\n',
    });
  });

  test('the Markdown diff defaults to the entry of the `to` version', async () => {
    clock.advance(1000);
    const published = await publishFiles(ctx, member.user, { 'index.md': 'one\n' });
    clock.advance(1000);
    await publishFiles(
      ctx,
      member.user,
      { 'index.md': 'one\n\ntwo\n' },
      {
        kind: 'new_version',
        artifactId: published.artifact.id,
        expectedVersionId: published.version.id,
      },
    );
    const r = await api.get(`/artifacts/${published.artifact.id}/diff/markdown?from=1&to=2`);
    expect(r.status).toBe(200);
    const diff = MarkdownDiff.parse(r.body);
    expect(diff.path).toBe('index.md');
    expect(diff.blocks.map((b) => b.op)).toEqual(['unchanged', 'added']);
  });

  test('versions are validated', async () => {
    for (const query of ['from=1&to=9', 'from=9&to=1']) {
      for (const route of ['diff', 'diff/file', 'diff/markdown']) {
        const r = await api.get(`/artifacts/${id}/${route}?${query}&path=a.txt`);
        expect([route, query, r.status]).toEqual([route, query, 404]);
        expect(message(r.body)).toBe(t('version.notFound'));
      }
    }
    expect((await api.get(`/artifacts/art_unknown/diff?from=1&to=2`)).status).toBe(404);
    await ctx.deps.db.db
      .deleteFrom('versions')
      .where('artifact_id', '=', id)
      .where('number', '=', 1)
      .execute();
    const gone = await api.get(`/artifacts/${id}/diff?from=1&to=2`);
    expect(gone.status).toBe(410);
    expect(message(gone.body)).toBe(t('version.gone'));
  });

  test('malformed queries are 400', async () => {
    for (const path of [
      `/artifacts/${id}/diff`,
      `/artifacts/${id}/diff?from=1`,
      `/artifacts/${id}/diff?from=0&to=2`,
      `/artifacts/${id}/diff?from=x&to=2`,
      `/artifacts/${id}/diff?from=1.5&to=2`,
      `/artifacts/${id}/diff/file?from=1&to=2`,
      `/artifacts/${id}/diff/file?from=1&to=2&path=`,
      `/artifacts/${id}/diff/markdown?from=1&to=2&path=`,
    ]) {
      const r = await api.get(path);
      expect([path, r.status]).toEqual([path, 400]);
    }
  });

  test('a path in neither version is 404', async () => {
    for (const route of ['diff/file', 'diff/markdown']) {
      const r = await api.get(`/artifacts/${id}/${route}?from=1&to=2&path=nope.md`);
      expect([route, r.status]).toEqual([route, 404]);
      expect(message(r.body)).toBe(t('diff.noFile'));
    }
  });

  test('a rendered diff is for Markdown files only', async () => {
    const r = await api.get(`/artifacts/${id}/diff/markdown?from=1&to=2&path=index.html`);
    expect(r.status).toBe(400);
    expect(message(r.body)).toBe(t('diff.notMarkdown'));
    // No path: the entry of version 2 is index.html.
    const byDefault = await api.get(`/artifacts/${id}/diff/markdown?from=1&to=2`);
    expect(byDefault.status).toBe(400);
    expect(message(byDefault.body)).toBe(t('diff.notMarkdown'));
  });

  test('every diff route needs a signed-in caller', async () => {
    for (const route of ['diff', 'diff/file', 'diff/markdown']) {
      const r = await ctx.request(`/api/v1/artifacts/${id}/${route}?from=1&to=2&path=a.txt`);
      expect([route, r.status]).toEqual([route, 401]);
    }
  });

  test('the routes are in the OpenAPI document', async () => {
    const res = await ctx.request('/api/v1/openapi.json');
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/artifacts/{id}/diff',
        '/artifacts/{id}/diff/file',
        '/artifacts/{id}/diff/markdown',
      ]),
    );
  });
});
