import { readdir, readFile } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * The only places that may act without a viewer (the roadmap's Global Constraints): each is bound
 * to something else that grants access, such as a share link, or serves the whole instance. A
 * path ending in `/` stands for every file under it. M12 adds its transfer, purge and admin files.
 */
const SYSTEM_SCOPE_ALLOWED = [
  'domain/spaces.ts',
  'domain/share-access.ts',
  'domain/comments.ts',
  'api/share-public.ts',
  'domain/search.ts',
  'domain/deletion.ts',
  'domain/blobs.ts',
  'ops/backup/',
  'domain/spaces-startup.ts',
  'publish/startup.ts',
  // An admin deletes everything one person owns (the purge in personal mode).
  'api/admin-users.ts',
  // Purge: an admin's of anyone's space, and a person's of their own (`purgeOwnSpace`).
  'domain/purge.ts',
  // admin moderation: metadata, revoke and delete by id, never content
  'api/admin-moderation.ts',
  // `pinwall transfer`: an operator moves one person's projects to another (never a route).
  'main.ts',
];

const allowed = (path: string) =>
  SYSTEM_SCOPE_ALLOWED.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );

/** Every source file of the server, by its path under `src/` with `/` separators. */
async function sources(): Promise<{ path: string; text: string }[]> {
  const paths = (await readdir(SRC, { recursive: true }))
    .filter((path) => /\.tsx?$/.test(path))
    .sort();
  return Promise.all(
    paths.map(async (path) => ({
      path: path.split(sep).join('/'),
      text: await readFile(join(SRC, path), 'utf8'),
    })),
  );
}

test('only the allow-list imports SYSTEM_SCOPE', async () => {
  const users = (await sources())
    .filter((file) => /\bSYSTEM_SCOPE\b/.test(file.text))
    .map((file) => file.path);
  // The guard reads the right tree: the scope's own module names it.
  expect(users).toContain('domain/spaces.ts');
  expect(users.filter((path) => !allowed(path))).toEqual([]);
});

/** The source files `text` (the file at `path`) imports by a relative path, as paths under `src/`. */
function importsOf(path: string, text: string): string[] {
  const specifiers = text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g);
  return [...specifiers].map((match) => posix.join(posix.dirname(path), match[1] ?? ''));
}

test('only the transfer command imports the transfer', async () => {
  // Moving a space is the CLI's alone: no route or tool may reach it.
  const importers = (await sources())
    .filter((file) => importsOf(file.path, file.text).includes('domain/transfer.ts'))
    .map((file) => file.path);
  expect(importers).toEqual(['main.ts']);
});

test('nobody but spaces.ts builds a scope by hand', async () => {
  const builders = (await sources())
    .filter((file) => /kind:\s*'(system|viewer)'/.test(file.text))
    .map((file) => file.path);
  expect(builders).toEqual(['domain/spaces.ts']);
});

/** The tables whose rows belong to a space. */
const CONTENT_TABLES = new Set([
  'artifacts',
  'projects',
  'comments',
  'share_links',
  'versions',
  'version_files',
  'project_members',
]);

/**
 * Each query on a content table that a route or tool in `api/` or `mcp/` builds itself, one entry
 * per query, with why it cannot reach another space. Everything else goes through the domain's
 * lookups, which apply `whereVisible`.
 */
const DIRECT_QUERIES_ALLOWED: { file: string; table: string; reason: string }[] = [
  {
    file: 'api/content.ts',
    table: 'version_files',
    reason: "the thumbnail's file row, of a version of an artifact the viewer's getArtifact found",
  },
  {
    file: 'api/events.ts',
    table: 'artifacts',
    reason: "a member stream's heartbeat check, whereVisible with the member's freshly read scope",
  },
];

/** A Kysely call that names a table: a query from it, a write to it, or a join onto it. */
const TABLE_CALL =
  /\b(?:selectFrom|updateTable|deleteFrom|insertInto|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*\[?\s*['"`]([a-z_]+)/g;

test('routes and tools query content tables only through scoped lookups or the allow-list', async () => {
  const queries = (await sources())
    .filter((file) => file.path.startsWith('api/') || file.path.startsWith('mcp/'))
    .flatMap((file) =>
      [...file.text.matchAll(TABLE_CALL)].map((match) => ({ file: file.path, table: match[1] })),
    )
    .filter(({ table }) => table !== undefined && CONTENT_TABLES.has(table))
    .map(({ file, table }) => `${file}: ${table}`)
    .sort();
  // Both ways: a query left off the list fails, and so does an entry whose query went away.
  expect(queries).toEqual(
    DIRECT_QUERIES_ALLOWED.map(({ file, table }) => `${file}: ${table}`).sort(),
  );
});

/**
 * A write reads the role it acts with through `holdRoleIn`, which holds the project first, so a
 * membership change that commits meanwhile is seen. Only `holdRoleIn` itself reads it in a
 * transaction otherwise, and `updateProject`: owner-only, and a FOR SHARE before its own UPDATE
 * of the project row would deadlock two renames.
 */
test('writes read roles with holdRoleIn', async () => {
  const readers = (await sources())
    .filter((file) => /\broleIn\(trx\b/.test(file.text))
    .map((file) => file.path);
  expect(readers).toEqual(['domain/projects.ts', 'domain/spaces.ts']);
});
