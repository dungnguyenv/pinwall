/*
 * The release helpers that .github/workflows/release.yml runs for a tag `v<version>`:
 *
 *   tsx src/release.ts check <tag>                        the tag is a release tag, every
 *                                                         package.json and the chart carry its
 *                                                         version, and CHANGELOG.md has its section
 *   tsx src/release.ts outputs <tag> <tags> --out <file>  writes the verify job's outputs (version,
 *                                                         prerelease, latest, image tags), given a
 *                                                         file of the repository's tags, one a line
 *   tsx src/release.ts notes <tag> <digest> --out <file>  writes the GitHub release notes
 *   tsx src/release.ts chart <tag> <digest>               sets the chart's version and image digest
 *
 * `check` runs before anything is built, so a tag that does not match the repository stops the
 * release there. Paths are relative to the repository root. Exit codes: 0 done, 1 a problem,
 * 2 a usage error.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Document, isScalar, parse, parseDocument } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CHART_DIR = 'deploy/helm/pinwall';
const IMAGE = 'ghcr.io/dungnguyenv/pinwall';
const CHART = 'oci://ghcr.io/dungnguyenv/charts/pinwall';
const REPOSITORY = 'dungnguyenv/pinwall';

// SemVer 2.0.0 without build metadata, which an image tag cannot carry (no `+`).
const NUMBER = '(?:0|[1-9]\\d*)';
const PRERELEASE_PART = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = `${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?`;
const VERSION_PATTERN = new RegExp(`^${VERSION}$`);
const TAG_PATTERN = new RegExp(`^v(${VERSION})$`);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The version a release tag names: 'v1.0.0' → '1.0.0'. Anything else throws. */
export function releaseVersion(tag: string): string {
  const version = TAG_PATTERN.exec(tag)?.[1];
  if (version === undefined) {
    throw new Error(
      `${JSON.stringify(tag)} is not a release tag: use v<major>.<minor>.<patch>, with an optional pre-release such as v1.1.0-rc.1`,
    );
  }
  return version;
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${JSON.stringify(version)} is not a release version`);
  }
}

/** Major, minor and patch of a version without a pre-release part: '1.10.0' → [1, 10, 0]. */
function numbers(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return [major, minor, patch];
}

/** Below zero when `a` comes before `b`, by major, then minor, then patch. */
function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The image tags a release of `version` gets, given every tag of the repository: the version
 * itself, then `<major>.<minor>`, `<major>` and `latest`, each only when no full release that it
 * covers is newer. So a patch for an older line (1.0.5 after 1.1.0) moves `1.0` but leaves `1`
 * and `latest` on 1.1.0. A pre-release gets its own tag only, and other pre-releases and tags
 * that are no release tag do not count.
 */
export function imageTags(version: string, repositoryTags: readonly string[]): string[] {
  assertVersion(version);
  if (version.includes('-')) return [version];
  const own = numbers(version);
  const releases = repositoryTags.flatMap((tag) => {
    const released = TAG_PATTERN.exec(tag)?.[1];
    return released === undefined || released.includes('-') ? [] : [numbers(released)];
  });
  /** Whether no release that shares the first `shared` numbers with this one is newer. */
  const newest = (shared: number) =>
    !releases.some(
      (other) =>
        other.slice(0, shared).every((n, i) => n === own[i]) && compareNumbers(other, own) > 0,
    );
  const [major, minor] = own;
  return [
    version,
    ...(newest(2) ? [`${major}.${minor}`] : []),
    ...(newest(1) ? [`${major}`] : []),
    ...(newest(0) ? ['latest'] : []),
  ];
}

function assertDigest(digest: string): void {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`${JSON.stringify(digest)} is not an image digest (sha256: and 64 hex digits)`);
  }
}

/**
 * The package.json files of the repository, relative to `root`: its own and each workspace
 * package's, from pnpm-workspace.yaml. A folder a pattern matches without a package.json is not
 * a package, as for pnpm.
 */
function packageFiles(root: string): string[] {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as {
    packages?: unknown;
  };
  const patterns = Array.isArray(workspace?.packages) ? workspace.packages : [];
  const dirs = patterns.flatMap((pattern: unknown): string[] => {
    if (typeof pattern !== 'string' || !/^[\w.-]+(\/[\w.-]+)*(\/\*)?$/.test(pattern)) {
      throw new Error(
        `pnpm-workspace.yaml: the pattern ${JSON.stringify(pattern)} is not supported`,
      );
    }
    if (!pattern.endsWith('/*')) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .sort();
  });
  return [
    'package.json',
    ...dirs
      .map((dir) => posix.join(dir, 'package.json'))
      .filter((file) => existsSync(join(root, file))),
  ];
}

/**
 * Each version in the repository that is not `version`: the `version` of every package.json, and
 * the chart's `version` and `appVersion`. An empty list means the repository is ready for it.
 */
export function checkVersions(root: string, version: string): string[] {
  const problems: string[] = [];
  const compare = (file: string, field: string, actual: unknown) => {
    if (actual === version) return;
    problems.push(
      actual === undefined || actual === null
        ? `${file}: no ${field}, but the tag is for ${version}`
        : `${file}: ${field} is ${String(actual)}, but the tag is for ${version}`,
    );
  };
  for (const file of packageFiles(root)) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as { version?: unknown };
    compare(file, 'version', manifest.version);
  }
  const chartFile = `${CHART_DIR}/Chart.yaml`;
  const chart = parse(readFileSync(join(root, chartFile), 'utf8')) as Record<string, unknown>;
  compare(chartFile, 'version', chart?.version);
  compare(chartFile, 'appVersion', chart?.appVersion);
  return problems;
}

/**
 * The body of the changelog's `## <version>` section (a date may follow the version), up to the
 * next `## ` heading. A missing or empty section throws.
 */
function changelogSection(changelog: string, version: string): string {
  // A release version holds only letters, digits, '-' and '.', so '.' is all there is to escape.
  assertVersion(version);
  const escaped = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^## ${escaped}(?:\\s.*)?$`);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
  if (body === '') throw new Error(`The "## ${version}" section of CHANGELOG.md is empty`);
  return body;
}

/**
 * The GitHub release notes: the changelog's section for `version`, then how to get the image
 * by its digest, install the chart, and verify the image as SECURITY.md describes.
 */
export function releaseNotes(changelog: string, version: string, p: { digest: string }): string {
  assertDigest(p.digest);
  const section = changelogSection(changelog, version);
  const image = `${IMAGE}@${p.digest}`;
  // One line per paragraph: a GitHub release shows every line break of its text.
  return [
    section,
    '',
    '### Image',
    '',
    `\`${image}\` (linux/amd64 and linux/arm64), also tagged \`${version}\`. Deploy it by its digest: a tag can be moved, a digest cannot.`,
    '',
    'The Helm chart refers to this image by digest:',
    '',
    '```sh',
    `helm install pinwall ${CHART} --version ${version} \\`,
    '  --set publicOrigin=https://pinwall.example',
    '```',
    '',
    `Check the image's signature and its build provenance, as [SECURITY.md](https://github.com/${REPOSITORY}/blob/v${version}/SECURITY.md) explains:`,
    '',
    '```sh',
    `cosign verify ${image} \\`,
    `  --certificate-identity https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/tags/v${version} \\`,
    '  --certificate-oidc-issuer https://token.actions.githubusercontent.com',
    '```',
    '',
    '```sh',
    `gh attestation verify oci://${image} --repo ${REPOSITORY}`,
    '```',
    '',
    `The image's SBOM (\`pinwall-${version}.spdx.json\`), its third-party notices and the chart are attached to this release.`,
    '',
  ].join('\n');
}

/** Sets the scalar at `path` of `doc`, keeping its quoting; throws when there is none. */
function setScalar(doc: Document, path: string[], value: string, file: string): void {
  const node = doc.getIn(path, true);
  if (!isScalar(node)) throw new Error(`${file} has no ${path.join('.')} to set`);
  node.value = value;
}

/** Edits a YAML file in place, keeping its comments and layout. */
function editYaml(file: string, change: (doc: Document) => void): string {
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]?.message}`);
  change(doc);
  // No folding of long lines, so a line the edit did not touch stays as it was.
  return doc.toString({ lineWidth: 0 });
}

/**
 * Makes the chart in `chartDir` the release's: `image.digest` in values.yaml, and `version` and
 * `appVersion` in Chart.yaml. Comments stay. Nothing is written unless both files can be set.
 */
export function setChartRelease(chartDir: string, p: { version: string; digest: string }): void {
  assertVersion(p.version);
  assertDigest(p.digest);
  const valuesFile = join(chartDir, 'values.yaml');
  const chartFile = join(chartDir, 'Chart.yaml');
  const values = editYaml(valuesFile, (doc) =>
    setScalar(doc, ['image', 'digest'], p.digest, valuesFile),
  );
  const chart = editYaml(chartFile, (doc) => {
    setScalar(doc, ['version'], p.version, chartFile);
    setScalar(doc, ['appVersion'], p.version, chartFile);
  });
  writeFileSync(valuesFile, values);
  writeFileSync(chartFile, chart);
}

const USAGE =
  'usage: release.ts check <tag> | outputs <tag> <tags-file> --out <file> | notes <tag> <digest> --out <file> | chart <tag> <digest>';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the command line against the repository at `root`; the result is the exit code. */
export function main(argv: string[], root: string = ROOT): number {
  let command: string | undefined;
  let tag: string | undefined;
  /** The third word: an image digest, or for `outputs` the file of repository tags. */
  let digest: string | undefined;
  let out: string | undefined;
  let count: number;
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { out: { type: 'string' } },
    });
    [command, tag, digest] = positionals;
    count = positionals.length;
    out = values.out;
  } catch (error) {
    console.error(`${messageOf(error)}\n${USAGE}`);
    return 2;
  }

  try {
    if (command === 'check' && tag !== undefined && count === 2 && out === undefined) {
      const version = releaseVersion(tag);
      const problems = checkVersions(root, version);
      try {
        changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
      } catch (error) {
        problems.push(messageOf(error));
      }
      if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error(`${tag}: the repository is not ready for this release`);
        return 1;
      }
      console.log(`${tag}: every version is ${version}, and CHANGELOG.md has its section`);
      return 0;
    }

    if (command === 'outputs' && tag !== undefined && digest !== undefined && count === 3 && out) {
      const version = releaseVersion(tag);
      const tagsFile = digest;
      const repositoryTags = readFileSync(resolve(root, tagsFile), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const tags = imageTags(version, repositoryTags);
      const lines = [
        `version=${version}`,
        `prerelease=${version.includes('-')}`,
        `latest=${tags.includes('latest')}`,
        `tags=${tags.map((name) => `${IMAGE}:${name}`).join(',')}`,
      ];
      const file = resolve(root, out);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${lines.join('\n')}\n`);
      console.log(`${tag}: image tags ${tags.join(', ')}`);
      return 0;
    }

    if (command === 'notes' && tag !== undefined && digest !== undefined && count === 3 && out) {
      const version = releaseVersion(tag);
      const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
      const notes = releaseNotes(changelog, version, { digest });
      const file = resolve(root, out);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, notes);
      console.log(`wrote ${file}`);
      return 0;
    }

    if (command === 'chart' && tag !== undefined && digest !== undefined && count === 3 && !out) {
      const version = releaseVersion(tag);
      setChartRelease(join(root, CHART_DIR), { version, digest });
      console.log(`${CHART_DIR}: version ${version}, image ${IMAGE}@${digest}`);
      return 0;
    }
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }

  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
