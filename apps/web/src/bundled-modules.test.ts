import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bundledModules } from '../vite-bundled-modules.ts';

let root = '';

beforeEach(async () => {
  // The real path: modules are reported by it, and macOS keeps tmp behind a link.
  root = await realpath(await mkdtemp(join(tmpdir(), 'pinwall-modules-')));
  await mkdir(join(root, 'src'));
  // dep.ts has code of its own (a constant would be folded into main.ts and leave no module).
  await writeFile(join(root, 'src/main.ts'), "import { greet } from './dep.ts';\ngreet();\n");
  await writeFile(join(root, 'src/dep.ts'), "export const greet = () => console.log('hello');\n");
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** A one-file library build of the fixture project with the plugin; `write` as given. */
function buildWith(outFile: string, write: boolean) {
  return build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [bundledModules({ repoRoot: root, outFile })],
    build: {
      write,
      outDir: join(root, 'dist'),
      lib: { entry: join(root, 'src/main.ts'), formats: ['es'] },
    },
  });
}

test('the ids of the modules in the output chunks are written, repo-relative and sorted', async () => {
  const outFile = join(root, '.build/modules.json');
  await buildWith(outFile, true);
  expect(JSON.parse(await readFile(outFile, 'utf8'))).toEqual(['src/dep.ts', 'src/main.ts']);
});

test('a build that does not write leaves the file alone', async () => {
  const outFile = join(root, '.build/modules.json');
  await buildWith(outFile, false);
  await expect(access(outFile)).rejects.toThrow();
});
