import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { systemDeleteVersion } from '../../src/domain/deletion.ts';
import {
  assertNoServerEdits,
  serverEditsOf,
  serverEditsSince,
} from '../../src/domain/server-edits.ts';
import { SYSTEM_SCOPE, scopeForUser } from '../../src/domain/spaces.ts';
import { type PublishTarget, restoreVersion } from '../../src/domain/versions.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { ingestEdit } from '../../src/publish/ingest.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 18);

/** What the promise rejects with, as an `AppError`. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('serverEditsOf', () => {
  test('is the paths of a meta that has them', () => {
    expect(serverEditsOf('{"warnings":[],"server_edits":["index.html","a/b.css"]}')).toEqual([
      'index.html',
      'a/b.css',
    ]);
  });

  test('is empty for a meta without the key, for invalid JSON and for other shapes', () => {
    expect(serverEditsOf('{"warnings":[]}')).toEqual([]);
    expect(serverEditsOf('not json')).toEqual([]);
    expect(serverEditsOf('')).toEqual([]);
    expect(serverEditsOf('null')).toEqual([]);
    expect(serverEditsOf('[]')).toEqual([]);
    expect(serverEditsOf('{"server_edits":"index.html"}')).toEqual([]);
    expect(serverEditsOf('{"server_edits":{"0":"index.html"}}')).toEqual([]);
  });

  test('keeps only the entries that are strings', () => {
    expect(serverEditsOf('{"server_edits":["a.html",3,null,"b.html"]}')).toEqual([
      'a.html',
      'b.html',
    ]);
  });
});

describe.each(dialects)('server edits on %s', (dialect) => {
  let ctx: TestContext;
  let ada: UserRow;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T) });
    ada = (await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' })).user;
  });
  afterEach(() => ctx.close());

  const FILES = { 'index.html': '<h1>Một</h1>', 'a.html': '<p>a</p>', 'b.html': '<p>b</p>' };

  /** A new artifact holding `FILES`: its id and version 1. */
  async function start(files: Record<string, string> = FILES) {
    const { artifact, version } = await publishFiles(ctx, ada, files);
    return { id: artifact.id, v1: version };
  }

  /** A new version of the artifact made as `edit_artifact` makes it, that rewrote `paths`. */
  async function edited(id: string, on: VersionRow, paths: readonly string[]): Promise<VersionRow> {
    const changed = new Map(
      paths.map((path) => [path, Buffer.from(`<p>${on.number} ${path}</p>`)]),
    );
    const { version } = await ingestEdit(
      ctx.deps,
      { artifactId: id, expectedVersionId: on.id, prepare: async () => changed },
      { actor: ada, source: 'mcp', message: null },
    );
    return version;
  }

  /** A new version made as a full publish of `files`. */
  async function full(id: string, on: VersionRow, files = FILES): Promise<VersionRow> {
    const { version } = await publishFiles(ctx, ada, files, {
      kind: 'new_version',
      artifactId: id,
      expectedVersionId: on.id,
    });
    return version;
  }

  const since = (version: VersionRow) => serverEditsSince(ctx.deps.db.db, version);

  describe('serverEditsSince', () => {
    test('the chain stops at the first full publish', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      const v3 = await edited(id, v2, ['b.html']);
      expect(await since(v3)).toEqual({
        paths: ['a.html', 'b.html'],
        versionNumbers: [3, 2],
        baseNumber: 1,
      });
      // From the middle of the chain, only what lies below.
      expect(await since(v2)).toEqual({ paths: ['a.html'], versionNumbers: [2], baseNumber: 1 });
    });

    test('a version without edits is its own base', async () => {
      const { v1 } = await start();
      expect(await since(v1)).toEqual({ paths: [], versionNumbers: [], baseNumber: 1 });
    });

    test('the paths are the union of every edit, each once, sorted', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['b.html', 'index.html']);
      const v3 = await edited(id, v2, ['a.html', 'b.html']);
      expect((await since(v3)).paths).toEqual(['a.html', 'b.html', 'index.html']);
    });

    test('a full publish on top of edits ends the chain there, and a later edit starts a new one', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      const v3 = await full(id, v2);
      expect(await since(v3)).toEqual({ paths: [], versionNumbers: [], baseNumber: 3 });
      const v4 = await edited(id, v3, ['b.html']);
      expect(await since(v4)).toEqual({ paths: ['b.html'], versionNumbers: [4], baseNumber: 3 });
    });

    test('a restore of an edited version carries its edits', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      const v3 = await full(id, v2);
      // Version 3 is clean, but version 2's files hold the edit, so the copy of it says so.
      const { version: v4 } = await restoreVersion(ctx.deps, ada, id, 2, v3.id);
      expect(v4.source).toBe('restore');
      expect(serverEditsOf(v4.meta)).toEqual(['a.html']);
      expect(await since(v4)).toEqual({ paths: ['a.html'], versionNumbers: [4], baseNumber: 3 });
    });

    test('a restore of a full publish carries none', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      const { version: v3 } = await restoreVersion(ctx.deps, ada, id, 1, v2.id);
      expect(serverEditsOf(v3.meta)).toEqual([]);
      expect(await since(v3)).toEqual({ paths: [], versionNumbers: [], baseNumber: 3 });
    });

    test('a chain that breaks at a deleted version has no base', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      const v3 = await edited(id, v2, ['b.html']);
      await systemDeleteVersion(ctx.deps, SYSTEM_SCOPE, id, 2);
      expect(await since(v3)).toEqual({ paths: ['b.html'], versionNumbers: [3], baseNumber: null });
    });
  });

  describe('assertNoServerEdits', () => {
    const scope = () => scopeForUser(ctx.deps, ada);
    const onVersion = (id: string, v: VersionRow): PublishTarget => ({
      kind: 'new_version',
      artifactId: id,
      expectedVersionId: v.id,
    });
    const check = (target: PublishTarget, replace = false) =>
      assertNoServerEdits(ctx.deps, scope(), target, replace);

    test('refuses a new version on top of edits, naming the paths and the versions', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      const v3 = await edited(id, v2, ['b.html']);
      const refused = await failure(check(onVersion(id, v3)));
      expect(refused.code).toBe('conflict');
      expect(refused.status).toBe(409);
      expect(refused.details).toEqual({
        reason: 'edited_on_server',
        paths: ['a.html', 'b.html'],
        more: 0,
        versions: [3, 2],
        base_version_number: 1,
      });
      expect(refused.message).toBe(
        t('publish.editedOnServer', { versions: 'v3, v2', paths: 'a.html, b.html' }),
      );
    });

    test('names at most 20 paths, then how many more', async () => {
      const names = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}.html`);
      const { id, v1 } = await start({ 'index.html': '<h1>x</h1>', ...fileSet(names) });
      const v2 = await edited(id, v1, names);
      const refused = await failure(check(onVersion(id, v2)));
      expect(refused.details).toMatchObject({
        reason: 'edited_on_server',
        paths: names.slice(0, 20),
        more: 5,
        versions: [2],
        base_version_number: 1,
      });
      expect(refused.message).toContain(
        `${names[19]} ${t('publish.editedOnServerMore', { count: 5 })}`,
      );
      expect(refused.message).not.toContain(names[20] ?? '');
    });

    test('a path in the message is on one line, whatever it holds', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      // Edits are recorded by the server from paths it has checked; the row is edited by hand here.
      await ctx.deps.db.db
        .updateTable('versions')
        .set({ meta: JSON.stringify({ warnings: [], server_edits: ['a\u001b[2J\u2028b.html'] }) })
        .where('id', '=', v2.id)
        .execute();
      const refused = await failure(check(onVersion(id, v2)));
      expect(refused.message).not.toMatch(/[\p{Cc}\p{Zl}]/u);
      expect(refused.message).toContain('a [2J b.html');
    });

    test('lets through a version that is not on edits, a new artifact and replace', async () => {
      const { id, v1 } = await start();
      await check(onVersion(id, v1));
      await check({ kind: 'new_artifact', projectId: null, name: null, tags: [] });

      const v2 = await edited(id, v1, ['a.html']);
      await check(onVersion(id, v2), true);
      // A full publish in between ends the chain.
      const v3 = await full(id, v2);
      await check(onVersion(id, v3));
    });

    test('a stale expected version is the version conflict, not the edits', async () => {
      const { id, v1 } = await start();
      const v2 = await edited(id, v1, ['a.html']);
      await edited(id, v2, ['b.html']);
      const refused = await failure(check(onVersion(id, v2)));
      expect(refused.code).toBe('version_conflict');
    });
  });
});

/** `paths` as files of a small page each, for a version that holds them all. */
function fileSet(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, `<p>${path}</p>`]));
}
