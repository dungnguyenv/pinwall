import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type AcceptanceItem,
  commandLine,
  IMAGE,
  ITEMS,
  imageBuild,
  main,
  type Result,
  renderReport,
  uniqueCommands,
} from '../src/acceptance.ts';
import { makeRoot } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

afterEach(() => {
  vi.restoreAllMocks();
});

/** The anchors GitHub gives the headings of a Markdown text (outside fenced code). */
function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : /^#{1,6}\s+(.+?)\s*#*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    slugs.add(
      heading
        .replace(/`/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
        .trim()
        .replace(/ /g, '-'),
    );
  }
  return slugs;
}

/** The folder of each workspace package, by package name. */
function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  const candidates = [
    'tools',
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(join(ROOT, group)).map((name) => `${group}/${name}`),
    ),
  ];
  for (const dir of candidates) {
    const manifest = join(ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    dirs.set((JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name, dir);
  }
  return dirs;
}

const rootScripts = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * The files a command names, relative to the repository root: the test files of
 * `pnpm --filter <pkg> exec vitest run <filters…>` (a filter names a test file without its
 * `.test.ts`), the `-c <config>` of a Playwright run, and for `pnpm <script>` the configs its
 * script passes with `-c`. A root script that does not exist is reported as a missing path.
 */
function pathsOf(command: readonly string[]): string[] {
  const paths: string[] = [];
  const run = command.indexOf('run');
  if (command.includes('vitest') && run !== -1) {
    const pkg = command[command.indexOf('--filter') + 1] ?? '';
    const dir = workspaceDirs().get(pkg) ?? `<no package ${pkg}>`;
    for (const filter of command.slice(run + 1).filter((arg) => !arg.startsWith('-'))) {
      paths.push(`${dir}/${filter}.test.ts`);
    }
  }
  command.forEach((arg, i) => {
    if (arg === '-c') paths.push(command[i + 1] ?? '');
  });
  if (command.length === 2 && command[0] === 'pnpm') {
    const script = rootScripts[command[1] ?? ''];
    if (script === undefined) paths.push(`<no root script ${command[1]}>`);
    else for (const [, config = ''] of script.matchAll(/-c (\S+)/g)) paths.push(config);
  }
  return paths;
}

describe('ITEMS', () => {
  test('lists the acceptance items of the spec, in its order', () => {
    expect(ITEMS.map((item) => item.id)).toEqual([
      '1',
      '2',
      '3',
      '3a',
      '3b',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
  });

  test('every item has a title and at least one automated command', () => {
    for (const item of ITEMS) {
      expect(item.title.trim(), item.id).not.toBe('');
      expect(item.automated.length, item.id).toBeGreaterThan(0);
      for (const check of item.automated) {
        expect(check.label.trim(), item.id).not.toBe('');
        expect(check.command.length, item.id).toBeGreaterThan(1);
      }
    }
  });

  test('every manual check is a heading of docs/acceptance.md', async () => {
    const slugs = headingSlugs(await readFile(join(ROOT, 'docs/acceptance.md'), 'utf8'));
    const manual = ITEMS.flatMap((item) => item.manual);
    expect(manual.length).toBeGreaterThan(0);
    expect(manual.filter((slug) => !slugs.has(slug))).toEqual([]);
  });

  test('the checklist names the manual checks of the brief', () => {
    const manual = new Set(ITEMS.flatMap((item) => item.manual));
    for (const slug of [
      'claude-code',
      'claude-desktop',
      'review-loop',
      'zitadel',
      'google',
      'cloudflare-tunnel',
      'two-machines',
    ]) {
      expect(manual.has(slug), slug).toBe(true);
    }
  });

  test('every test file and config a command names exists', () => {
    const named = ITEMS.flatMap((item) => item.automated.flatMap((c) => pathsOf(c.command)));
    expect(new Set(named)).toEqual(
      new Set([
        'e2e/acceptance.config.ts',
        'apps/server/test/mcp/agent-flow.test.ts',
        'apps/server/test/auth/oidc/flow.test.ts',
        'e2e/keycloak/keycloak.config.ts',
        'e2e/review.config.ts',
        'apps/server/test/api/review-flow.test.ts',
        'apps/server/test/api/publishing-flow.test.ts',
      ]),
    );
    expect(named.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });

  test('the Playwright acceptance suite holds the install and backup-restore specs', () => {
    for (const spec of ['install.spec.ts', 'backup-restore.spec.ts']) {
      expect(existsSync(join(ROOT, 'e2e/acceptance', spec)), spec).toBe(true);
    }
  });

  test('items that share a command share it exactly, so it runs once', () => {
    const commands = uniqueCommands();
    expect(commands.map((c) => commandLine(c.command))).toEqual([
      'pnpm exec playwright test -c e2e/acceptance.config.ts',
      'pnpm --filter @pinwall/server exec vitest run test/mcp/agent-flow',
      'pnpm --filter @pinwall/server exec vitest run test/auth/oidc/flow',
      'pnpm test:e2e:keycloak',
      'pnpm test:e2e:review',
      'pnpm --filter @pinwall/server exec vitest run test/api/review-flow test/api/publishing-flow',
    ]);
    const byLine = (id: string) =>
      ITEMS.find((item) => item.id === id)?.automated.map((c) => commandLine(c.command));
    for (const id of ['1', '6', '7', '9', '10']) {
      expect(byLine(id), id).toEqual(['pnpm exec playwright test -c e2e/acceptance.config.ts']);
    }
    expect(byLine('4')).toEqual([
      'pnpm --filter @pinwall/server exec vitest run test/mcp/agent-flow',
      'pnpm test:e2e:review',
    ]);
  });
});

describe('imageBuild', () => {
  test('builds pinwall:acceptance from the repository root', () => {
    expect(IMAGE).toBe('pinwall:acceptance');
    expect(imageBuild({})).toEqual(['docker', 'build', '-t', 'pinwall:acceptance', '.']);
    expect(imageBuild({ PINWALL_ACCEPTANCE_IMAGE: '' })).toEqual([
      'docker',
      'build',
      '-t',
      'pinwall:acceptance',
      '.',
    ]);
  });

  test('is skipped when PINWALL_ACCEPTANCE_IMAGE names an image built already', () => {
    expect(imageBuild({ PINWALL_ACCEPTANCE_IMAGE: 'pinwall:ci' })).toBeNull();
  });
});

describe('renderReport', () => {
  const PLAYWRIGHT = 'pnpm exec playwright test -c e2e/acceptance.config.ts';
  const KEYCLOAK = 'pnpm test:e2e:keycloak';

  /** The table rows of a report, split into trimmed cells, without the header and its rule. */
  function rows(report: string): string[][] {
    return report
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .slice(2)
      .map((line) =>
        line
          .slice(1, -1)
          .split(' | ')
          .map((cell) => cell.trim()),
      );
  }

  test('is a Markdown table with one row per item, in order', () => {
    const report = renderReport(new Map());
    expect(report).toContain('| Item | Automated by | Result | Manual check |');
    expect(report).toContain('| --- | --- | --- | --- |');
    const table = rows(report);
    expect(table.map((row) => row[0]?.split(' ')[0])).toEqual(ITEMS.map((item) => item.id));
    for (const [i, item] of ITEMS.entries()) {
      expect(table[i]?.[0]).toBe(`${item.id} ${item.title}`);
      for (const check of item.automated) expect(table[i]?.[1]).toContain(check.label);
    }
  });

  test('an item passes only when every command it needs passed', () => {
    const results = new Map<string, Result>(
      uniqueCommands().map((c) => [commandLine(c.command), 'pass']),
    );
    results.set(KEYCLOAK, 'fail');
    const table = rows(renderReport(results));
    const result = (id: string) => table[ITEMS.findIndex((item) => item.id === id)]?.[2];
    expect(result('1')).toBe('pass');
    expect(result('3')).toBe('fail');
    expect(result('3b')).toBe('fail');
    expect(result('2')).toBe('pass');
  });

  test('a command that did not run leaves its items "not run"', () => {
    const table = rows(renderReport(new Map([[PLAYWRIGHT, 'pass']])));
    const result = (id: string) => table[ITEMS.findIndex((item) => item.id === id)]?.[2];
    expect(result('1')).toBe('pass');
    expect(result('2')).toBe('not run');
  });

  test('names the manual checks of an item, or a dash when it has none', () => {
    const table = rows(renderReport(new Map()));
    const manual = (item: AcceptanceItem) => table[ITEMS.indexOf(item)]?.[3];
    for (const item of ITEMS) {
      if (item.manual.length === 0) expect(manual(item), item.id).toBe('—');
      for (const slug of item.manual) {
        expect(manual(item), item.id).toContain(`docs/acceptance.md#${slug}`);
      }
    }
  });
});

describe('main', () => {
  test('builds the image, runs each command once, writes the report and fails if one fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reportPath = join(await makeRoot(), 'nested', 'report.md');
    const ran: string[] = [];
    const code = await main({
      env: {},
      reportPath,
      run: async (command) => {
        ran.push(commandLine(command));
        return command.includes('test:e2e:keycloak') ? 1 : 0;
      },
    });
    expect(code).toBe(1);
    expect(ran).toEqual([
      'docker build -t pinwall:acceptance .',
      ...uniqueCommands().map((c) => commandLine(c.command)),
    ]);
    const report = await readFile(reportPath, 'utf8');
    expect(report).toContain('| fail |');
    expect(report).toContain('| pass |');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('| Item |'));
  });

  test('skips the build for a given image and passes when every command passes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const reportPath = join(await makeRoot(), 'report.md');
    const ran: string[] = [];
    const code = await main({
      env: { PINWALL_ACCEPTANCE_IMAGE: 'pinwall:ci' },
      reportPath,
      run: async (command) => {
        ran.push(commandLine(command));
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(ran).not.toContain('docker build -t pinwall:acceptance .');
    expect(ran).toHaveLength(uniqueCommands().length);
    expect(await readFile(reportPath, 'utf8')).not.toContain('| fail |');
  });

  test('stops after a failed image build, with every item "not run"', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reportPath = join(await makeRoot(), 'report.md');
    const ran: string[] = [];
    const code = await main({
      env: {},
      reportPath,
      run: async (command) => {
        ran.push(commandLine(command));
        return 1;
      },
    });
    expect(code).toBe(1);
    expect(ran).toEqual(['docker build -t pinwall:acceptance .']);
    const report = await readFile(reportPath, 'utf8');
    expect(report).not.toContain('| pass |');
    expect(report).toContain('The image did not build');
    expect(console.error).toHaveBeenCalled();
  });
});
