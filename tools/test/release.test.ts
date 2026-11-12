import { execFile } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import {
  checkVersions,
  main,
  releaseNotes,
  releaseVersion,
  setChartRelease,
} from '../src/release.ts';
import { makeRoot, write } from './helpers.ts';

const run = promisify(execFile);

const ROOT = resolve(import.meta.dirname, '..', '..');
const REAL_CHART = join(ROOT, 'deploy/helm/pinwall');
const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;

const CHANGELOG = `# Changelog

Every release, newest first.

## 1.1.0-rc.1

### Added

- Something not released yet.

## 1.0.0

### Added

- **Publishing.** The first entry.
- The second entry.

### Fixed

- A fix.

## 0.9.0

- An older entry.
`;

/**
 * A repository with every version at `version` and a changelog with a section for it:
 * pnpm-workspace.yaml, the root and workspace package.json files, and a small chart.
 */
async function makeRepo(version = '1.0.0'): Promise<string> {
  const root = await makeRoot();
  await write(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - apps/*\n  - packages/*\n  - tools\n',
  );
  await write(join(root, 'package.json'), { name: 'pinwall', version });
  for (const dir of ['apps/server', 'apps/web', 'packages/shared', 'tools']) {
    await write(join(root, dir, 'package.json'), { name: `@pinwall/${dir}`, version });
  }
  await write(
    join(root, 'deploy/helm/pinwall/Chart.yaml'),
    `apiVersion: v2\nname: pinwall\n# The release sets both.\nversion: ${version}\nappVersion: "${version}"\n`,
  );
  await write(
    join(root, 'deploy/helm/pinwall/values.yaml'),
    'image:\n  repository: ghcr.io/dungnguyenv/pinwall\n  # The image digest.\n  digest: ""\n',
  );
  await write(join(root, 'CHANGELOG.md'), CHANGELOG);
  return root;
}

/** The lines of `after` that differ from `before`, as [line number, old line, new line]. */
function changedLines(before: string, after: string): [number, string, string][] {
  const old = before.split('\n');
  const now = after.split('\n');
  expect(now).toHaveLength(old.length);
  return old.flatMap((line, i): [number, string, string][] =>
    line === now[i] ? [] : [[i, line, now[i] ?? '']],
  );
}

/** Runs `main` with the console silenced, and returns the exit code and what it printed. */
function runMain(argv: string[], root?: string) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = main(argv, root);
    return {
      code,
      out: log.mock.calls.map((call) => call.join(' ')).join('\n'),
      err: error.mock.calls.map((call) => call.join(' ')).join('\n'),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('releaseVersion', () => {
  test.each([
    ['v1.0.0', '1.0.0'],
    ['v1.1.0-rc.1', '1.1.0-rc.1'],
    ['v10.20.30', '10.20.30'],
    ['v2.0.0-beta.2.x-y', '2.0.0-beta.2.x-y'],
  ])('%s is version %s', (tag, version) => {
    expect(releaseVersion(tag)).toBe(version);
  });

  test.each([
    '1.0.0',
    'v1',
    'vx',
    'v1.0',
    'v01.0.0',
    'v1.0.0-',
    'v1.0.0-rc.01',
    'v1.0.0+build.5',
    'V1.0.0',
    'refs/tags/v1.0.0',
    ' v1.0.0',
    'v1.0.0\n',
    '',
  ])('%j is not a release tag', (tag) => {
    expect(() => releaseVersion(tag)).toThrow('not a release tag');
  });
});

describe('checkVersions', () => {
  test('a repository where everything says the version has no problem', async () => {
    expect(checkVersions(await makeRepo('1.0.0'), '1.0.0')).toEqual([]);
  });

  test('one package.json with another version is the one problem, by name', async () => {
    const root = await makeRepo('1.0.0');
    await write(join(root, 'apps/web/package.json'), { name: '@pinwall/web', version: '0.9.0' });
    expect(checkVersions(root, '1.0.0')).toEqual([
      'apps/web/package.json: version is 0.9.0, but the tag is for 1.0.0',
    ]);
  });

  test('every file is named when the tag is for another version', async () => {
    const problems = checkVersions(await makeRepo('1.0.0'), '1.0.1');
    expect(problems).toEqual([
      'package.json: version is 1.0.0, but the tag is for 1.0.1',
      'apps/server/package.json: version is 1.0.0, but the tag is for 1.0.1',
      'apps/web/package.json: version is 1.0.0, but the tag is for 1.0.1',
      'packages/shared/package.json: version is 1.0.0, but the tag is for 1.0.1',
      'tools/package.json: version is 1.0.0, but the tag is for 1.0.1',
      'deploy/helm/pinwall/Chart.yaml: version is 1.0.0, but the tag is for 1.0.1',
      'deploy/helm/pinwall/Chart.yaml: appVersion is 1.0.0, but the tag is for 1.0.1',
    ]);
  });

  test('the chart version and appVersion are checked apart, and a missing version counts', async () => {
    const root = await makeRepo('1.0.0');
    await write(
      join(root, 'deploy/helm/pinwall/Chart.yaml'),
      'apiVersion: v2\nname: pinwall\nversion: 1.0.0\n',
    );
    await write(join(root, 'packages/shared/package.json'), { name: '@pinwall/shared' });
    expect(checkVersions(root, '1.0.0')).toEqual([
      'packages/shared/package.json: no version, but the tag is for 1.0.0',
      'deploy/helm/pinwall/Chart.yaml: no appVersion, but the tag is for 1.0.0',
    ]);
  });

  test('a version YAML reads as a number is not the release version', async () => {
    const root = await makeRepo('1.0.0');
    await write(
      join(root, 'deploy/helm/pinwall/Chart.yaml'),
      'apiVersion: v2\nname: pinwall\nversion: 1.0\nappVersion: "1.0.0"\n',
    );
    expect(checkVersions(root, '1.0.0')).toEqual([
      'deploy/helm/pinwall/Chart.yaml: version is 1, but the tag is for 1.0.0',
    ]);
  });

  test('a folder under a workspace pattern without package.json is not a package', async () => {
    const root = await makeRepo('1.0.0');
    await write(join(root, 'apps/notes/README.md'), 'not a package');
    expect(checkVersions(root, '1.0.0')).toEqual([]);
  });

  test('every version in this repository is the root package.json version', async () => {
    const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    expect(checkVersions(ROOT, version)).toEqual([]);
  });
});

describe('releaseNotes', () => {
  test("the version's section, from its heading to the next release heading", () => {
    const notes = releaseNotes(CHANGELOG, '1.0.0', { digest: DIGEST });
    expect(notes.startsWith('### Added\n\n- **Publishing.** The first entry.\n')).toBe(true);
    expect(notes).toContain('### Fixed\n\n- A fix.\n');
    expect(notes).not.toContain('An older entry');
    expect(notes).not.toContain('Something not released yet');
    expect(notes).not.toContain('## 0.9.0');
  });

  test('the last section runs to the end of the changelog', () => {
    const notes = releaseNotes(CHANGELOG, '0.9.0', { digest: DIGEST });
    expect(notes.startsWith('- An older entry.\n')).toBe(true);
  });

  test('a heading may carry a date after the version', () => {
    const notes = releaseNotes('## 1.0.0 - 2026-11-20\n\n- Entry.\n', '1.0.0', { digest: DIGEST });
    expect(notes.startsWith('- Entry.\n')).toBe(true);
  });

  test('a changelog without the version throws', () => {
    expect(() => releaseNotes(CHANGELOG, '2.0.0', { digest: DIGEST })).toThrow(
      'CHANGELOG.md has no "## 2.0.0" section',
    );
  });

  test('a pre-release section is not the section of its release', () => {
    const changelog = '## 1.1.0-rc.1\n\n- Entry.\n';
    expect(() => releaseNotes(changelog, '1.1.0', { digest: DIGEST })).toThrow(
      'no "## 1.1.0" section',
    );
  });

  test.each(['v1.0.0', '1.0', '1.0.0+build', '1.0.0|0.9.0'])(
    '%j is refused as a version',
    (version) => {
      expect(() => releaseNotes(CHANGELOG, version, { digest: DIGEST })).toThrow(
        'not a release version',
      );
    },
  );

  test('an empty section throws', () => {
    const changelog = '# Changelog\n\n## 1.0.0\n\n  \n## 0.9.0\n\n- Entry.\n';
    expect(() => releaseNotes(changelog, '1.0.0', { digest: DIGEST })).toThrow(
      'The "## 1.0.0" section of CHANGELOG.md is empty',
    );
  });

  test('the image by digest and the chart install command', () => {
    const notes = releaseNotes(CHANGELOG, '1.0.0', { digest: DIGEST });
    expect(notes).toContain('### Image');
    expect(notes).toContain(`ghcr.io/dungnguyenv/pinwall@${DIGEST}`);
    expect(notes).toContain(
      'helm install pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version 1.0.0 \\\n',
    );
  });

  test("SECURITY.md's verify commands, for this digest", async () => {
    const security = await readFile(join(ROOT, 'SECURITY.md'), 'utf8');
    const blocks = [...security.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
    const cosign = blocks.find((block) => block.startsWith('cosign verify '));
    const gh = blocks.find((block) => block.startsWith('gh attestation verify '));
    expect(cosign).toBeDefined();
    expect(gh).toBeDefined();

    const notes = releaseNotes(CHANGELOG, '1.0.0', { digest: DIGEST });
    for (const command of [cosign, gh]) {
      expect(command).toContain('@sha256:<digest>');
      expect(notes).toContain(command?.replaceAll('sha256:<digest>', DIGEST));
    }
  });

  test.each(['', 'latest', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(64)}`])(
    'the digest %j is refused',
    (digest) => {
      expect(() => releaseNotes(CHANGELOG, '1.0.0', { digest })).toThrow('not an image digest');
    },
  );
});

describe('setChartRelease', () => {
  async function chartCopy(): Promise<string> {
    const dir = join(await makeRoot(), 'pinwall');
    await cp(REAL_CHART, dir, { recursive: true });
    return dir;
  }

  test("sets the image digest, the version and appVersion, and keeps the files' comments", async () => {
    const dir = await chartCopy();
    const values = await readFile(join(dir, 'values.yaml'), 'utf8');
    const chart = await readFile(join(dir, 'Chart.yaml'), 'utf8');

    setChartRelease(dir, { version: '1.2.3-rc.1', digest: DIGEST });

    const newValues = await readFile(join(dir, 'values.yaml'), 'utf8');
    const newChart = await readFile(join(dir, 'Chart.yaml'), 'utf8');
    expect(parse(newValues).image.digest).toBe(DIGEST);
    expect(parse(newChart)).toMatchObject({ version: '1.2.3-rc.1', appVersion: '1.2.3-rc.1' });

    // Only the three values change; every comment and every other line stays as it was.
    const [digestLine, ...otherValueLines] = changedLines(values, newValues);
    expect(otherValueLines).toEqual([]);
    expect(digestLine?.[2]).toBe(`  digest: "${DIGEST}"`);
    const above = values.split('\n')[(digestLine?.[0] ?? 0) - 1];
    expect(above).toMatch(/^ {2}# /);
    expect(newValues.split('\n')[(digestLine?.[0] ?? 0) - 1]).toBe(above);
    expect(changedLines(chart, newChart).map(([, , line]) => line)).toEqual([
      'version: 1.2.3-rc.1',
      'appVersion: "1.2.3-rc.1"',
    ]);
  });

  test('a bad digest or version changes nothing', async () => {
    const dir = await chartCopy();
    const values = await readFile(join(dir, 'values.yaml'), 'utf8');
    const chart = await readFile(join(dir, 'Chart.yaml'), 'utf8');

    expect(() => setChartRelease(dir, { version: '1.0.0', digest: 'latest' })).toThrow(
      'not an image digest',
    );
    expect(() => setChartRelease(dir, { version: 'v1.0.0', digest: DIGEST })).toThrow(
      'not a release version',
    );
    expect(await readFile(join(dir, 'values.yaml'), 'utf8')).toBe(values);
    expect(await readFile(join(dir, 'Chart.yaml'), 'utf8')).toBe(chart);
  });

  test('values.yaml without image.digest is an error, not a new key', async () => {
    const dir = join(await makeRoot(), 'pinwall');
    await write(join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: pinwall\nversion: 1.0.0\n');
    await write(join(dir, 'values.yaml'), 'image:\n  repository: ghcr.io/dungnguyenv/pinwall\n');
    expect(() => setChartRelease(dir, { version: '1.0.0', digest: DIGEST })).toThrow(
      'has no image.digest',
    );
  });
});

describe('the command line', () => {
  test('check passes when the tag, every version and the changelog agree', async () => {
    const result = runMain(['check', 'v1.0.0'], await makeRepo('1.0.0'));
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('1.0.0');
  });

  test('check fails on a version that differs from the tag', async () => {
    const root = await makeRepo('1.0.0');
    await write(join(root, 'tools/package.json'), { name: '@pinwall/tools', version: '0.9.0' });
    const result = runMain(['check', 'v1.0.0'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('tools/package.json: version is 0.9.0, but the tag is for 1.0.0');
  });

  test('check fails when the changelog has no section for the version', async () => {
    const root = await makeRepo('1.0.0');
    await write(join(root, 'CHANGELOG.md'), CHANGELOG.replace('## 1.0.0\n', '## 1.0.0-rc.2\n'));
    const result = runMain(['check', 'v1.0.0'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('CHANGELOG.md has no "## 1.0.0" section');
  });

  test('check fails on a tag that is not a release tag', async () => {
    const result = runMain(['check', 'v1.0'], await makeRepo('1.0.0'));
    expect(result.code).toBe(1);
    expect(result.err).toContain('"v1.0" is not a release tag');
  });

  test('notes writes the notes to a path relative to the repository root', async () => {
    const root = await makeRepo('1.0.0');
    expect(runMain(['notes', 'v1.0.0', DIGEST, '--out', 'out/notes.md'], root).code).toBe(0);
    const notes = await readFile(join(root, 'out/notes.md'), 'utf8');
    expect(notes).toBe(releaseNotes(CHANGELOG, '1.0.0', { digest: DIGEST }));
  });

  test('chart sets the chart in deploy/helm/pinwall', async () => {
    const root = await makeRepo('1.0.0');
    expect(runMain(['chart', 'v1.1.0', DIGEST], root).code).toBe(0);
    const chartDir = join(root, 'deploy/helm/pinwall');
    expect(parse(await readFile(join(chartDir, 'values.yaml'), 'utf8')).image.digest).toBe(DIGEST);
    expect(parse(await readFile(join(chartDir, 'Chart.yaml'), 'utf8'))).toMatchObject({
      version: '1.1.0',
      appVersion: '1.1.0',
    });
  });

  test.each([
    [[]],
    [['check']],
    [['check', 'v1.0.0', 'extra']],
    [['notes', 'v1.0.0', DIGEST]],
    [['chart', 'v1.0.0']],
    [['chart', 'v1.0.0', DIGEST, '--out', 'x']],
    [['publish', 'v1.0.0']],
    [['check', 'v1.0.0', '--force']],
  ])('%j is a usage error', async (argv) => {
    const result = runMain(argv, await makeRepo('1.0.0'));
    expect(result.code).toBe(2);
    expect(result.err).toContain('usage: release.ts');
  });

  test('this repository passes check for its own version', async () => {
    const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    expect(runMain(['check', `v${version}`])).toMatchObject({ code: 0, err: '' });
  });

  test('the real command line exits 1 when the tag does not match', async () => {
    const script = join(ROOT, 'tools/src/release.ts');
    const failed = await run(process.execPath, ['--import', 'tsx', script, 'check', 'v0.0.1'], {
      cwd: join(ROOT, 'tools'),
    }).then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain('package.json: version is');
    expect(failed?.stderr).toContain('but the tag is for 0.0.1');
  });
});
