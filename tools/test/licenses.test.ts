import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import {
  BUILD_ONLY_ALLOWED,
  checkLicenses,
  installedPackages,
  packageOfModule,
  renderNotices,
  SHIPPED_ALLOWED,
  shippedPackages,
} from '../src/licenses.ts';
import { satisfiesLicense } from '../src/spdx.ts';
import { info, installFixture, link, makeRoot, write } from './helpers.ts';

const REPO = join(import.meta.dirname, '..', '..');

test('the shipped list is the Global Constraints list and build-only code may add MPL-2.0', () => {
  expect([...SHIPPED_ALLOWED].sort()).toEqual(
    [
      '0BSD',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'BlueOak-1.0.0',
      'CC0-1.0',
      'ISC',
      'MIT',
      'PSF-2.0',
      'Python-2.0',
      'Unicode-3.0',
      'Unicode-DFS-2016',
      'Unlicense',
    ].sort(),
  );
  expect([...BUILD_ONLY_ALLOWED].sort()).toEqual([...SHIPPED_ALLOWED, 'MPL-2.0'].sort());
  expect(satisfiesLicense('MPL-2.0', SHIPPED_ALLOWED)).toBe(false);
  expect(satisfiesLicense('MPL-2.0', BUILD_ONLY_ALLOWED)).toBe(true);
});

test('MPL-2.0 is allowed only for build-only packages', () => {
  const shipped = checkLicenses([info('lightningcss', '1.0.0', 'MPL-2.0', ['web'])], [], {});
  expect(shipped).toHaveLength(1);
  expect(shipped[0]).toContain('lightningcss');
  expect(shipped[0]).toContain('MPL-2.0');
  expect(checkLicenses([], [info('lightningcss', '1.0.0', 'MPL-2.0', [])], {})).toEqual([]);
});

test('a package that is shipped is judged as shipped even when it is also installed', () => {
  const asInstalled = info('lightningcss', '1.0.0', 'MPL-2.0', []);
  const asShipped = info('lightningcss', '1.0.0', 'MPL-2.0', ['web']);
  expect(checkLicenses([asShipped], [asInstalled], {})).toHaveLength(1);
  // Another version of the same package is a different package.
  expect(
    checkLicenses([asShipped], [info('lightningcss', '2.0.0', 'MPL-2.0', [])], {}),
  ).toHaveLength(1);
});

test('GPL and missing licenses fail unless excepted', () => {
  const gpl = info('x', '1.0.0', 'GPL-3.0-only', []);
  const none = info('x', '1.0.0', null, []);
  expect(checkLicenses([], [gpl], {})).toHaveLength(1);
  expect(checkLicenses([], [none], {})).toHaveLength(1);
  expect(checkLicenses([], [none], {})[0]).toContain('no license');
  const ex = { x: { license: 'GPL-3.0-only', reason: 'a build tool that never ships' } };
  expect(checkLicenses([], [gpl], ex)).toEqual([]);
  expect(checkLicenses([], [none], ex)).toEqual([]);
});

test('an exception can be pinned to one version, and it holds only for the license it names', () => {
  const ccby = info('caniuse-lite', '1.0.5', 'CC-BY-4.0', []);
  const reason = 'browser support data read by build tools; never bundled';
  expect(
    checkLicenses([], [ccby], { 'caniuse-lite@1.0.5': { license: 'CC-BY-4.0', reason } }),
  ).toEqual([]);
  expect(
    checkLicenses([], [ccby], { 'caniuse-lite@1.0.4': { license: 'CC-BY-4.0', reason } }),
  ).toHaveLength(1);
  // The package changed its license after the exception was written.
  const changed = info('caniuse-lite', '1.0.6', 'GPL-3.0-only', []);
  const problems = checkLicenses([], [changed], {
    'caniuse-lite': { license: 'CC-BY-4.0', reason },
  });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('CC-BY-4.0');
});

test('every problem is one line, and each package is reported once', () => {
  const dup = info('x', '1.0.0', 'GPL-3.0-only', []);
  const problems = checkLicenses([], [dup, { ...dup }, info('y', '1.0.0', null, [])], {});
  expect(problems).toHaveLength(2);
  expect(problems.every((line) => !line.includes('\n'))).toBe(true);
});

test('packageOfModule finds the real package behind pnpm paths and type stubs', async () => {
  const root = await makeRoot();
  const dir = await installFixture(root, 'a', '1.0.0');
  const found = await packageOfModule(join(dir, 'dist', 'esm', 'x.js'));
  expect(found).toMatchObject({ name: 'a', version: '1.0.0', license: 'MIT' });
  expect(found?.dir).toBe(dir);
});

test('packageOfModule skips workspace packages, virtual ids and query strings', async () => {
  const root = await makeRoot();
  const dir = await installFixture(root, 'a', '1.0.0');
  expect(await packageOfModule('\0vite/preload-helper.js')).toBeNull();
  expect(await packageOfModule(join(dir, 'dist', 'esm', 'x.js?raw'))).toMatchObject({ name: 'a' });

  const shared = join(root, 'packages', 'shared');
  await write(join(shared, 'package.json'), { name: '@pinwall/shared', version: '0.0.0' });
  await write(join(shared, 'src', 'index.ts'), 'export {};');
  expect(await packageOfModule(join(shared, 'src', 'index.ts'))).toBeNull();

  await write(join(root, 'package.json'), { name: 'pinwall', version: '1.0.0' });
  await write(join(root, 'scripts', 'x.mjs'), '');
  expect(await packageOfModule(join(root, 'scripts', 'x.mjs'))).toBeNull();
});

test('packageOfModule reads the license from the older field shapes', async () => {
  const root = await makeRoot();
  const object = join(root, 'node_modules', 'o');
  await write(join(object, 'package.json'), {
    name: 'o',
    version: '1.0.0',
    license: { type: 'MIT' },
  });
  const list = join(root, 'node_modules', 'l');
  await write(join(list, 'package.json'), {
    name: 'l',
    version: '1.0.0',
    licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
  });
  const none = join(root, 'node_modules', 'n');
  await write(join(none, 'package.json'), { name: 'n', version: '1.0.0' });
  expect((await packageOfModule(join(object, 'index.js')))?.license).toBe('MIT');
  expect((await packageOfModule(join(list, 'index.js')))?.license).toBe('(MIT OR Apache-2.0)');
  expect((await packageOfModule(join(none, 'index.js')))?.license).toBeNull();
});

async function asShipped(file: string, shippedIn: ('server' | 'web')[]) {
  const found = await packageOfModule(file);
  if (!found) throw new Error(`no package for ${file}`);
  return { ...found, shippedIn };
}

test('notices carry license and NOTICE texts, sorted and de-duplicated', async () => {
  const root = await makeRoot();
  const a = await installFixture(root, 'a', '1.0.0');
  const b = await installFixture(root, 'b', '2.0.0');
  const text = await renderNotices(
    [
      await asShipped(join(b, 'index.js'), ['web']),
      await asShipped(join(a, 'dist', 'esm', 'x.js'), ['web']),
      await asShipped(join(a, 'dist', 'esm', 'x.js'), ['server']),
    ],
    {},
    '1.2.3',
  );
  expect(text.startsWith('Pinwall 1.2.3 — third-party notices\n')).toBe(true);
  expect(text.indexOf('a 1.0.0 — MIT')).toBeGreaterThan(0);
  expect(text.indexOf('a 1.0.0 — MIT')).toBeLessThan(text.indexOf('b 2.0.0 — ISC'));
  expect(text.match(/^a 1\.0\.0 — MIT$/gm)).toHaveLength(1);
  expect(text).toContain('Included in: server, web');
  expect(text).toContain('Copyright (c) Fixture A');
  expect(text).toContain('Copyright (c) Fixture B');
  expect(text.match(/Copyright Fixture A Contributors/g)).toHaveLength(1);
  // The package's license text comes before its NOTICE text.
  expect(text.indexOf('Copyright (c) Fixture A')).toBeLessThan(
    text.indexOf('Copyright Fixture A Contributors'),
  );
});

test('notices find the license files under their usual names and skip code named like them', async () => {
  const root = await makeRoot();
  const dir = join(root, 'node_modules', 'many');
  await write(join(dir, 'package.json'), { name: 'many', version: '1.0.0', license: 'Unlicense' });
  await write(join(dir, 'UNLICENSE'), 'This is free and unencumbered software.\n');
  await write(join(dir, 'COPYING'), 'Copying terms.\r\n');
  await write(join(dir, 'LICENSE-MIT'), 'The MIT terms.\n');
  await write(join(dir, 'NOTICE.txt'), 'A notice.\n');
  await write(join(dir, 'license.js'), 'module.exports = "code";\n');
  await write(join(dir, 'licenses.json'), '["data"]\n');
  const pkg = await asShipped(join(dir, 'index.js'), ['web']);
  const text = await renderNotices([pkg], {}, '1.0.0');
  for (const expected of [
    'free and unencumbered',
    'Copying terms.\n',
    'The MIT terms.',
    'A notice.',
  ]) {
    expect(text).toContain(expected);
  }
  expect(text).not.toContain('module.exports');
  expect(text).not.toContain('"data"');
  expect(text).not.toContain('\r');
});

test('a package without license text fails the notices unless an exception carries the text', async () => {
  const root = await makeRoot();
  const bare = await installFixture(root, 'bare', '3.0.0');
  const pkg = await asShipped(join(bare, 'index.js'), ['server']);
  await expect(renderNotices([pkg], {}, '1.0.0')).rejects.toThrow(/bare/);
  const text = await renderNotices(
    [pkg],
    {
      bare: { license: 'MIT', reason: 'ships no license file', text: 'Copyright the bare authors' },
    },
    '1.0.0',
  );
  expect(text).toContain('bare 3.0.0 — MIT');
  expect(text).toContain('Copyright the bare authors');
});

/** A repository with one build of the server, annotator and web app, in pnpm's layout. */
async function builtRepo() {
  const root = await makeRoot();
  const a = await installFixture(root, 'a', '1.0.0');
  const b = await installFixture(root, 'b', '2.0.0');
  const rel = (file: string) => file.slice(root.length + 1);
  await write(join(root, 'apps/server/.build/bundles.json'), {
    server: ['apps/server/src/main.ts', rel(join(a, 'dist/esm/x.js'))],
    annotator: [rel(join(b, 'index.js'))],
  });
  await write(join(root, 'apps/web/.build/modules.json'), [
    rel(join(a, 'dist/esm/x.js')),
    '\0vite/preload-helper.js',
    'apps/web/src/main.tsx',
  ]);
  await write(join(root, 'apps/server/package.json'), {
    name: '@pinwall/server',
    version: '0.0.0',
  });
  await write(join(root, 'apps/web/package.json'), { name: '@pinwall/web', version: '0.0.0' });
  return { root, a, b };
}

test('shippedPackages merges the server, annotator and web inputs and the runtime folder', async () => {
  const { root, a, b } = await builtRepo();
  // tailwindcss is compiled into the SPA's CSS, so no module of it is ever in a chunk.
  const tailwind = join(root, 'node_modules/.pnpm/tailwindcss@4.0.0/node_modules/tailwindcss');
  await write(join(tailwind, 'package.json'), {
    name: 'tailwindcss',
    version: '4.0.0',
    license: 'MIT',
  });
  await link(join(root, 'apps/web/node_modules/tailwindcss'), tailwind);
  const runtime = join(root, 'runtime/node_modules');
  await write(join(runtime, 'native/package.json'), {
    name: 'native',
    version: '5.0.0',
    license: 'MIT',
  });
  await write(join(runtime, '@scope/dep/package.json'), {
    name: '@scope/dep',
    version: '6.0.0',
    license: 'ISC',
  });

  const shipped = await shippedPackages(root, { runtimeDir: runtime });
  expect(shipped.map((p) => `${p.name}@${p.version} ${p.shippedIn.join('+')}`)).toEqual([
    '@scope/dep@6.0.0 runtime',
    'a@1.0.0 server+web',
    'b@2.0.0 annotator',
    'native@5.0.0 runtime',
    'tailwindcss@4.0.0 web',
  ]);
  expect(shipped.find((p) => p.name === 'a')?.dir).toBe(a);
  expect(shipped.find((p) => p.name === 'b')?.dir).toBe(b);
});

test('without a runtime folder, the runtime is better-sqlite3 and its dependencies minus node-addon-api', async () => {
  const { root } = await builtRepo();
  const tailwind = join(root, 'node_modules/.pnpm/tailwindcss@4.0.0/node_modules/tailwindcss');
  await write(join(tailwind, 'package.json'), {
    name: 'tailwindcss',
    version: '4.0.0',
    license: 'MIT',
  });
  await link(join(root, 'apps/web/node_modules/tailwindcss'), tailwind);

  const store = join(root, 'node_modules/.pnpm');
  const sqlite = join(store, 'better-sqlite3@13.0.0/node_modules/better-sqlite3');
  await write(join(sqlite, 'package.json'), {
    name: 'better-sqlite3',
    version: '13.0.0',
    license: 'MIT',
    dependencies: { 'node-addon-api': '^8.0.0', bindings: '^1.5.0' },
    devDependencies: { mocha: '^11.0.0' },
  });
  const bindings = join(store, 'bindings@1.5.0/node_modules/bindings');
  await write(join(bindings, 'package.json'), {
    name: 'bindings',
    version: '1.5.0',
    license: 'MIT',
    dependencies: { 'file-uri-to-path': '1.0.0' },
  });
  const uri = join(store, 'file-uri-to-path@1.0.0/node_modules/file-uri-to-path');
  await write(join(uri, 'package.json'), {
    name: 'file-uri-to-path',
    version: '1.0.0',
    license: 'MIT',
  });
  const addon = join(store, 'node-addon-api@8.0.0/node_modules/node-addon-api');
  await write(join(addon, 'package.json'), {
    name: 'node-addon-api',
    version: '8.0.0',
    license: 'MIT',
  });
  await link(join(dirname(sqlite), 'bindings'), bindings);
  await link(join(dirname(sqlite), 'node-addon-api'), addon);
  await link(join(dirname(bindings), 'file-uri-to-path'), uri);
  await link(join(root, 'apps/server/node_modules/better-sqlite3'), sqlite);

  const names = (await shippedPackages(root))
    .filter((p) => p.shippedIn.includes('runtime'))
    .map((p) => p.name);
  expect(names).toEqual(['better-sqlite3', 'bindings', 'file-uri-to-path']);
});

test('shippedPackages says to build first when a build output is missing', async () => {
  const root = await makeRoot();
  await expect(shippedPackages(root)).rejects.toThrow(/pnpm build/);
});

test('installedPackages lists what pnpm installed, with one entry per version', async () => {
  const installed = await installedPackages(REPO);
  const hono = installed.filter((p) => p.name === 'hono');
  expect(hono).toHaveLength(1);
  expect(hono[0]).toMatchObject({ license: 'MIT', shippedIn: [] });
  expect(hono[0]?.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(hono[0]?.dir).toContain(join('node_modules', '.pnpm'));
  expect(installed.some((p) => p.name.startsWith('@pinwall/'))).toBe(false);
}, 30_000);
