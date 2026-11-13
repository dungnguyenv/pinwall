import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/** The id of the 1.0 default project. Built here so this file does not name it either. */
const FIXED_DEFAULT_ID = ['prj', '0'.repeat(20)].join('_');

/** Every file under `dir`, but not the test fixtures in `skip`. */
function sourceFiles(dir: string, skip: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === skip ? [] : sourceFiles(path, skip);
    return [path];
  });
}

// A person's default project is whichever of their own projects is_default. In personal mode every
// person has one, with its own id, so nothing in the app may count on the 1.0 id.
test('the web app never names the 1.0 default project id', () => {
  const src = import.meta.dirname;
  const named = sourceFiles(src, join(src, 'test')).filter((path) =>
    readFileSync(path, 'utf8').includes(FIXED_DEFAULT_ID),
  );
  expect(named).toEqual([]);
});
