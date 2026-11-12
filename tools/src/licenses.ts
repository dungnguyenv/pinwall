/*
 * The license check and the third-party notices.
 *
 * What ships (the server bundle, the SPA, the annotator script and the runtime node_modules of
 * the image) may use only the licenses in SHIPPED_ALLOWED. Packages that only build or test
 * Pinwall may also use MPL-2.0. Anything else needs an entry, with a reason, in
 * tools/license-exceptions.json.
 *
 * Which packages ship is read from the builds themselves: the esbuild metafiles of the server and
 * the annotator, and the modules in the SPA's output chunks. A package that is installed but not
 * in any of them is build- or test-only.
 *
 *   tsx src/licenses.ts check
 *   tsx src/licenses.ts notices --out <file> [--runtime-dir <dir>]
 */
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { satisfiesLicense } from './spdx.ts';

/** What may ship: the Global Constraints list of the M9b plan. */
export const SHIPPED_ALLOWED: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Python-2.0',
  'PSF-2.0',
]);

/** What may be installed to build and test Pinwall without ever shipping. */
export const BUILD_ONLY_ALLOWED: ReadonlySet<string> = new Set([...SHIPPED_ALLOWED, 'MPL-2.0']);

/** Where a package ends up, in the order notices list them. */
const SHIPMENTS = ['server', 'web', 'annotator', 'runtime'] as const;
type Shipment = (typeof SHIPMENTS)[number];

export interface PackageInfo {
  name: string;
  version: string;
  license: string | null;
  dir: string;
  shippedIn: Shipment[];
}

type Located = Omit<PackageInfo, 'shippedIn'>;

/** The part of a package.json these tools read. */
interface Manifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A package.json, or null when there is none in `dir`. */
async function readManifest(dir: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(join(dir, 'package.json'), 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text) as Manifest;
  } catch (error) {
    throw new Error(`${join(dir, 'package.json')} is not valid JSON`, { cause: error });
  }
}

/** The license a manifest declares as one SPDX expression, or null; reads the older shapes too. */
function declaredLicense(manifest: Manifest): string | null {
  const { license, licenses } = manifest;
  const typeOf = (entry: unknown): string | null => {
    const value =
      typeof entry === 'string' ? entry : (entry as { type?: unknown } | null | undefined)?.type;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const single = typeOf(license);
  if (single) return single;
  if (Array.isArray(licenses)) {
    const types = licenses.map(typeOf).filter((type): type is string => type !== null);
    if (types.length === 1) return types[0] ?? null;
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

function describe(dir: string, manifest: Manifest): Located | null {
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return null;
  return {
    name: manifest.name,
    version: manifest.version,
    license: declaredLicense(manifest),
    dir,
  };
}

const NODE_MODULES = 'node_modules';

/** The project's own code: a workspace package, or anything outside a node_modules folder. */
function isOwnCode(found: Located): boolean {
  return found.name.startsWith('@pinwall/') || !found.dir.split(sep).includes(NODE_MODULES);
}

type PackageCache = Map<string, Located | null>;

/** `packageOfModule` with a cache of what each folder resolved to, for walking many modules. */
async function locate(file: string, cache: PackageCache): Promise<Located | null> {
  if (file.startsWith('\0')) return null;
  const path = file.replace(/\?.*$/, '');
  let dir = dirname(await realpath(path).catch(() => path));
  const walked: string[] = [];
  let found: Located | null = null;
  for (;;) {
    if (cache.has(dir)) {
      found = cache.get(dir) ?? null;
      break;
    }
    walked.push(dir);
    const manifest = await readManifest(dir);
    const described = manifest && describe(dir, manifest);
    if (described) {
      found = isOwnCode(described) ? null : described;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const visited of walked) cache.set(visited, found);
  return found;
}

/**
 * The package a module file belongs to: the nearest package.json above it that has a name and a
 * version (so the `{"type":"module"}` stubs inside a package are skipped). pnpm's real paths
 * (`node_modules/.pnpm/<name>@<version>/node_modules/<name>/…`) work as they are. Null for
 * Pinwall's own code (the workspace packages), for virtual ids that start with "\0", and for
 * a file with no package above it.
 */
export function packageOfModule(file: string): Promise<Located | null> {
  return locate(file, new Map());
}

function packageKey(pkg: { name: string; version: string }): string {
  return `${pkg.name}@${pkg.version}`;
}

/** Packages in the order notices and reports list them: by name, then version. */
function byNameAndVersion(a: Located, b: Located): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/** One entry per name and version, joining where each was found. */
function mergePackages(packages: PackageInfo[]): PackageInfo[] {
  const merged = new Map<string, PackageInfo>();
  for (const pkg of packages) {
    const known = merged.get(packageKey(pkg));
    if (known) {
      known.shippedIn = SHIPMENTS.filter(
        (where) => known.shippedIn.includes(where) || pkg.shippedIn.includes(where),
      );
    } else {
      merged.set(packageKey(pkg), { ...pkg, shippedIn: [...pkg.shippedIn] });
    }
  }
  return [...merged.values()].sort(byNameAndVersion);
}

async function readBuildOutput<T>(root: string, file: string, producer: string): Promise<T> {
  const path = join(root, file);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isMissing(error))
      throw new Error(`${file} is missing; run \`pnpm build\` (${producer}) first`);
    throw error;
  }
}

/** A module id from a build output: repo-relative, or virtual ("\0…"). */
function moduleFile(root: string, id: string): string {
  return id.startsWith('\0') || isAbsolute(id) ? id : resolve(root, id);
}

/** Every package folder of a node_modules directory, looking into `@scope` folders. */
async function packageFolders(nodeModules: string): Promise<string[]> {
  const folders: string[] = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      for (const inner of await readdir(path, { withFileTypes: true })) {
        if (!inner.name.startsWith('.')) folders.push(join(path, inner.name));
      }
    } else {
      folders.push(path);
    }
  }
  return folders.sort();
}

/** Dependencies the image never needs at run time: better-sqlite3 uses it only to compile. */
const COMPILE_ONLY = new Set(['node-addon-api']);

/** The folder of dependency `name` as Node finds it from the package in `from`. */
async function findDependency(from: string, name: string): Promise<string | null> {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, NODE_MODULES, name);
    try {
      await access(join(candidate, 'package.json'));
      return await realpath(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** better-sqlite3 and its production dependencies, minus what is only for compiling. */
async function defaultRuntimePackages(root: string): Promise<Located[]> {
  const start = join(root, 'apps/server', NODE_MODULES, 'better-sqlite3');
  const found: Located[] = [];
  const visited = new Set<string>();
  const queue = [await realpath(start)];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    if (visited.has(dir)) continue;
    visited.add(dir);
    const manifest = await readManifest(dir);
    const pkg = manifest && describe(dir, manifest);
    if (!manifest || !pkg) throw new Error(`${dir} has no package name and version`);
    found.push(pkg);
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const dependencies = [...Object.keys(manifest.dependencies ?? {}), ...optional];
    for (const name of dependencies) {
      if (COMPILE_ONLY.has(name)) continue;
      const dependency = await findDependency(dir, name);
      if (dependency) queue.push(dependency);
      else if (!optional.has(name))
        throw new Error(`${pkg.name} needs ${name}, which is not installed`);
    }
  }
  return found;
}

/** Every package inside a runtime node_modules folder, as the image ships it. */
async function runtimeFolderPackages(nodeModules: string): Promise<Located[]> {
  const found: Located[] = [];
  for (const folder of await packageFolders(nodeModules)) {
    const dir = await realpath(folder);
    const manifest = await readManifest(dir);
    const pkg = manifest && describe(dir, manifest);
    if (!pkg)
      throw new Error(`${folder} is not a package: it has no package.json with a name and version`);
    found.push(pkg);
  }
  return found;
}

/**
 * The packages that ship, with where each ends up:
 * - `server` and `annotator`: the inputs of the two esbuild bundles (`apps/server/.build/bundles.json`);
 * - `web`: the modules in the SPA's chunks (`apps/web/.build/modules.json`), and `tailwindcss`,
 *   which is compiled into the SPA's CSS without being a module of any chunk;
 * - `runtime`: every package under `o.runtimeDir`, else better-sqlite3 and its production
 *   dependencies minus node-addon-api, which is what the Dockerfile copies.
 */
export async function shippedPackages(
  root: string,
  o: { runtimeDir?: string } = {},
): Promise<PackageInfo[]> {
  const bundles = await readBuildOutput<{ server: string[]; annotator: string[] }>(
    root,
    'apps/server/.build/bundles.json',
    '@pinwall/server',
  );
  const webModules = await readBuildOutput<string[]>(
    root,
    'apps/web/.build/modules.json',
    '@pinwall/web',
  );

  const cache: PackageCache = new Map();
  const found: PackageInfo[] = [];
  const modulesOf = async (ids: string[], shippedIn: Shipment) => {
    for (const id of ids) {
      const file = moduleFile(root, id);
      const pkg = await locate(file, cache);
      if (pkg) found.push({ ...pkg, shippedIn: [shippedIn] });
      else if (file.split(sep).includes(NODE_MODULES)) {
        throw new Error(`cannot tell which package ${id} belongs to`);
      }
    }
  };
  await modulesOf(bundles.server, 'server');
  await modulesOf(bundles.annotator, 'annotator');
  await modulesOf(webModules, 'web');

  const tailwind = await locate(
    join(root, 'apps/web', NODE_MODULES, 'tailwindcss', 'package.json'),
    cache,
  );
  if (!tailwind) throw new Error('tailwindcss is not installed for apps/web');
  found.push({ ...tailwind, shippedIn: ['web'] });

  const runtime = o.runtimeDir
    ? await runtimeFolderPackages(o.runtimeDir)
    : await defaultRuntimePackages(root);
  for (const pkg of runtime) found.push({ ...pkg, shippedIn: ['runtime'] });

  return mergePackages(found);
}

interface PnpmLicenseEntry {
  name: string;
  versions: string[];
  paths: string[];
}

const run = promisify(execFile);

/** Every installed package, development dependencies included, as `pnpm licenses list` sees it. */
export async function installedPackages(root: string): Promise<PackageInfo[]> {
  const { stdout } = await run('pnpm', ['--recursive', 'licenses', 'list', '--json'], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  const byLicense = JSON.parse(stdout) as Record<string, PnpmLicenseEntry[]>;
  const packages: PackageInfo[] = [];
  for (const [license, entries] of Object.entries(byLicense)) {
    for (const entry of entries) {
      entry.versions.forEach((version, index) => {
        packages.push({
          name: entry.name,
          version,
          license: license.trim() === '' || license === 'Unknown' ? null : license,
          dir: entry.paths[index] ?? entry.paths[0] ?? '',
          shippedIn: [],
        });
      });
    }
  }
  return mergePackages(packages);
}

/**
 * Packages whose license is not on a list, each with the license it is allowed to have and why.
 * The key is a package name, or `name@version` for one version only.
 */
export type LicenseExceptions = Record<string, { license: string; reason: string; text?: string }>;

function exceptionFor(pkg: Located, exceptions: LicenseExceptions) {
  return exceptions[packageKey(pkg)] ?? exceptions[pkg.name];
}

/**
 * What is wrong with the licenses, one problem per line; empty when all is well. Shipped packages
 * must be on SHIPPED_ALLOWED; any other installed package may also be MPL-2.0. An exception allows
 * a package only while it declares the license the exception names.
 */
export function checkLicenses(
  shipped: PackageInfo[],
  installed: PackageInfo[],
  exceptions: LicenseExceptions,
): string[] {
  const problems: string[] = [];
  const checked = new Set<string>();
  const check = (pkg: PackageInfo, allowed: ReadonlySet<string>, where: string) => {
    const key = packageKey(pkg);
    if (checked.has(key)) return;
    checked.add(key);
    if (pkg.license !== null && satisfiesLicense(pkg.license, allowed)) return;
    const exception = exceptionFor(pkg, exceptions);
    if (exception) {
      if (pkg.license === null || sameLicense(pkg.license, exception.license)) return;
      problems.push(
        `${key}: declares ${pkg.license}, but its exception in tools/license-exceptions.json is for ${exception.license}`,
      );
      return;
    }
    problems.push(
      pkg.license === null
        ? `${key}: no license is declared (${where})`
        : `${key}: ${pkg.license} is not allowed (${where})`,
    );
  };
  for (const pkg of shipped) check(pkg, SHIPPED_ALLOWED, `shipped in ${pkg.shippedIn.join(', ')}`);
  for (const pkg of installed) check(pkg, BUILD_ONLY_ALLOWED, 'build or test only');
  return problems;
}

function sameLicense(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const LICENSE_FILE = /^(?:(?:un)?licen[cs]e|copying)/i;
const NOTICE_FILE = /^notice/i;
/** Files named like a license that are code or data, not text. */
const NOT_TEXT = /\.(?:[cm]?[jt]s|json|map|html|css|ya?ml)$/i;

/** The texts of the package's files whose names match `pattern`, in name order. */
async function textsOf(dir: string, pattern: RegExp): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => pattern.test(n) && !NOT_TEXT.test(n)).sort();
  const texts: string[] = [];
  for (const name of names) {
    if (!(await stat(join(dir, name))).isFile()) continue;
    const text = (await readFile(join(dir, name), 'utf8')).replace(/\r\n?/g, '\n').trim();
    if (text) texts.push(text);
  }
  return texts;
}

const RULE = '-'.repeat(78);

const INTRODUCTION =
  'Pinwall includes the packages below in its server bundle, its web app, its annotator script ' +
  'and the runtime of its container image. Each is used under its own license, reproduced after ' +
  "the package's name together with its NOTICE text where it has one. Pinwall's own license is in " +
  'the LICENSE file. This file is generated by `pnpm licenses:notices`; do not edit it.';

/**
 * The third-party notices for `shipped`: a header, then each package (once, by name) with its
 * license text and NOTICE text taken from the package's own files. A package with no license text
 * of its own needs `text` in its exception; without it this throws, naming the package.
 */
export async function renderNotices(
  shipped: PackageInfo[],
  exceptions: LicenseExceptions,
  version: string,
): Promise<string> {
  const sections: string[] = [];
  for (const pkg of mergePackages(shipped)) {
    const exception = exceptionFor(pkg, exceptions);
    const licenseTexts = await textsOf(pkg.dir, LICENSE_FILE);
    if (licenseTexts.length === 0 && exception?.text) licenseTexts.push(exception.text.trim());
    if (licenseTexts.length === 0) {
      throw new Error(
        `${packageKey(pkg)} has no license file in ${pkg.dir}; add its text to tools/license-exceptions.json`,
      );
    }
    const notices = await textsOf(pkg.dir, NOTICE_FILE);
    sections.push(
      [
        RULE,
        `${pkg.name} ${pkg.version} — ${pkg.license ?? exception?.license ?? 'unknown license'}`,
        `Included in: ${pkg.shippedIn.join(', ')}`,
        '',
        [...licenseTexts, ...notices].join('\n\n'),
      ].join('\n'),
    );
  }
  return `Pinwall ${version} — third-party notices\n\n${INTRODUCTION}\n\n${sections.join('\n\n')}\n`;
}

/** The repository root: the nearest parent holding pnpm-workspace.yaml. */
async function findRoot(from: string): Promise<string> {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      await access(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(dir) === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
  }
}

async function loadExceptions(root: string): Promise<LicenseExceptions> {
  const file = join(root, 'tools/license-exceptions.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as LicenseExceptions;
  for (const [key, entry] of Object.entries(parsed)) {
    if (!entry?.license?.trim() || !entry.reason?.trim()) {
      throw new Error(`${file}: the exception for ${key} needs a "license" and a "reason"`);
    }
  }
  return parsed;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function report(problems: string[]): void {
  for (const problem of problems) console.error(problem);
}

const USAGE = 'usage: licenses.ts check | notices --out <file> [--runtime-dir <dir>]';

/** Runs the command line; the result is the exit code. */
async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, 'runtime-dir': { type: 'string' } },
  });
  const [command] = positionals;
  const root = await findRoot(import.meta.dirname);
  const exceptions = await loadExceptions(root);
  // Paths on the command line are relative to the repository root, not to tools/.
  const fromRoot = (path: string) => resolve(root, path);

  if (command === 'check' && positionals.length === 1) {
    const shipped = await shippedPackages(root);
    const installed = await installedPackages(root);
    const problems = checkLicenses(shipped, installed, exceptions);
    report(problems);
    console.log(
      `${plural(shipped.length, 'shipped package')} and ${plural(installed.length, 'installed package')} checked: ${plural(problems.length, 'problem')}`,
    );
    return problems.length === 0 ? 0 : 1;
  }

  if (command === 'notices' && positionals.length === 1 && values.out) {
    const runtimeDir = values['runtime-dir'] ? fromRoot(values['runtime-dir']) : undefined;
    const shipped = await shippedPackages(root, { runtimeDir });
    const problems = checkLicenses(shipped, [], exceptions);
    if (problems.length > 0) {
      report(problems);
      console.error(plural(problems.length, 'problem'));
      return 1;
    }
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const out = fromRoot(values.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await renderNotices(shipped, exceptions, version));
    console.log(`wrote ${out}: ${plural(shipped.length, 'package')}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
