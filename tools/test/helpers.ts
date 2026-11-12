import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import type { PackageInfo } from '../src/licenses.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'packages');

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A fresh, empty directory standing in for a repository root; removed after the test. */
export async function makeRoot(): Promise<string> {
  // The real path: on macOS the temporary folder is behind a symbolic link.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pinwall-tools-')));
  roots.push(root);
  return root;
}

/** Writes `contents` (a string, or an object written as JSON) to `file`, creating its folders. */
export async function write(file: string, contents: string | object): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

/**
 * Copies the fixture package `name` into pnpm's layout under `root`,
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, and returns that folder.
 */
export async function installFixture(root: string, name: string, version: string): Promise<string> {
  const dir = join(root, 'node_modules', '.pnpm', `${name}@${version}`, 'node_modules', name);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** A symbolic link at `path` to the folder `target`, the way pnpm links a dependency. */
export async function link(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, 'dir');
}

export function info(
  name: string,
  version: string,
  license: string | null,
  shippedIn: PackageInfo['shippedIn'],
  dir = `/nowhere/${name}`,
): PackageInfo {
  return { name, version, license, dir, shippedIn };
}
