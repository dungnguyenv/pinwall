import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { CONFIG_VARS } from '../../apps/server/src/config/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** The documents the project publishes to its readers, relative to the repository root. */
function docFiles(): string[] {
  const topLevel = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/${name}`);
  return [...topLevel, ...docs, 'deploy/helm/pinwall/README.md'];
}

const FENCE = /^ {0,3}(```|~~~)/;

/** The text of a document with its fenced code blocks and inline code spans removed. */
function proseOf(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null && marker !== undefined) fence = marker;
    else if (fence !== null && marker === fence) fence = null;
    else if (fence === null) kept.push(line.replace(/`[^`\n]*`/g, ''));
  }
  return kept.join('\n');
}

/**
 * The anchor GitHub gives a heading: lower case, links reduced to their text, everything but
 * letters, digits, spaces, hyphens and underscores dropped, spaces turned into hyphens.
 */
function slugOf(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

/** Every anchor a document offers: its heading slugs, with `-1`, `-2` on repeats. */
function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const [, heading = ''] of proseOf(markdown).matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const slug = slugOf(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/** The targets of the inline links and images in a document's prose. */
function linkTargetsOf(markdown: string): string[] {
  const targets: string[] = [];
  for (const [, target = ''] of proseOf(markdown).matchAll(
    /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  )) {
    targets.push(target);
  }
  return targets;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** What is wrong with the relative links and anchors of the document `file` (a path from the root). */
async function linkProblems(file: string, markdown: string): Promise<string[]> {
  const problems: string[] = [];
  for (const target of linkTargetsOf(markdown)) {
    if (SCHEME.test(target)) continue;
    const [path = '', fragment] = target.split('#');
    const targetFile = path === '' ? file : relative(ROOT, resolve(ROOT, dirname(file), path));
    if (path !== '' && !existsSync(join(ROOT, targetFile))) {
      problems.push(`${file}: ${target} does not exist`);
      continue;
    }
    if (fragment === undefined || fragment === '') continue;
    if (path !== '' && !targetFile.endsWith('.md')) continue;
    const source = path === '' ? markdown : await readFile(join(ROOT, targetFile), 'utf8');
    if (!anchorsOf(source).has(fragment)) {
      problems.push(`${file}: ${target} matches no heading of ${targetFile}`);
    }
  }
  return problems;
}

/** Names that documents may use although the server does not read them. */
const NOT_SERVER_SETTINGS = new Set([
  // The reader's own shell variable in docs/connect-an-agent.md, holding an API token.
  'PINWALL_TOKEN',
  // Variables of the Compose files in deploy/compose, read by Compose and not by Pinwall.
  'PINWALL_IMAGE',
  'PINWALL_PORT_PUBLISHED',
  'PINWALL_SECRETS_DIR',
  // Variables of the acceptance run (pnpm test:acceptance), described in docs/acceptance.md.
  'PINWALL_ACCEPTANCE_IMAGE',
  'PINWALL_ACCEPTANCE_PORT',
]);

/**
 * The `PINWALL_*` names in a text that are neither server settings, nor `<secret>_FILE`, nor a
 * prefix of settings written with a trailing `*` (as in `PINWALL_S3_*`).
 */
function unknownSettings(text: string): string[] {
  const known = CONFIG_VARS.map((v) => v.name);
  const withFile = new Set(CONFIG_VARS.filter((v) => v.secret).map((v) => `${v.name}_FILE`));
  const unknown = new Set<string>();
  for (const [name = ''] of text.matchAll(/PINWALL_[A-Z0-9_]+\*?/g)) {
    const accepted = name.endsWith('*')
      ? known.some((setting) => setting.startsWith(name.slice(0, -1)))
      : known.includes(name) || withFile.has(name) || NOT_SERVER_SETTINGS.has(name);
    if (!accepted) unknown.add(name);
  }
  return [...unknown];
}

describe('the checks themselves', () => {
  test('slugOf follows the GitHub rules', () => {
    expect(slugOf('Behind a proxy or Cloudflare Tunnel')).toBe(
      'behind-a-proxy-or-cloudflare-tunnel',
    );
    expect(slugOf('Moving to Postgres + S3')).toBe('moving-to-postgres--s3');
    expect(slugOf('The `PINWALL_ISOLATION` switch')).toBe('the-pinwall_isolation-switch');
    expect(slugOf('Chụp ảnh: [a link](x.md)')).toBe('chụp-ảnh-a-link');
  });

  test('anchorsOf numbers repeated headings and ignores code blocks', () => {
    const doc = [
      '# Top',
      '## Same',
      '## Same',
      '```sh',
      '# not a heading',
      '```',
      '## Last ##',
    ].join('\n');
    expect([...anchorsOf(doc)]).toEqual(['top', 'same', 'same-1', 'last']);
  });

  test('linkTargetsOf reads links and images, and skips code', () => {
    const doc = [
      '[a](one.md) and ![b](two.png "title")',
      '`[c](three.md)`',
      '```',
      '[d](four.md)',
      '```',
    ].join('\n');
    expect(linkTargetsOf(doc)).toEqual(['one.md', 'two.png']);
  });

  test('linkProblems reports a missing file and a missing anchor', async () => {
    const problems = await linkProblems(
      'README.md',
      '[x](no-such-file.md) [y](#no-such-heading) [z](docs/configuration.md#no-such-heading) [ok](#top)\n# Top\n',
    );
    expect(problems).toEqual([
      'README.md: no-such-file.md does not exist',
      'README.md: #no-such-heading matches no heading of README.md',
      'README.md: docs/configuration.md#no-such-heading matches no heading of docs/configuration.md',
    ]);
  });

  test('unknownSettings accepts settings, secret _FILE names and setting prefixes only', () => {
    const text =
      'PINWALL_PUBLIC_ORIGIN PINWALL_SECRET_KEY_FILE PINWALL_TOKEN PINWALL_S3_* ' +
      'PINWALL_DATA_DIR_FILE PINWALL_MADE_UP PINWALL_NOPE_*';
    expect(unknownSettings(text)).toEqual([
      'PINWALL_DATA_DIR_FILE',
      'PINWALL_MADE_UP',
      'PINWALL_NOPE_*',
    ]);
  });
});

describe('the published documents', () => {
  const files = docFiles();

  test.each(files)('%s exists', (file) => {
    expect(existsSync(join(ROOT, file))).toBe(true);
  });

  test.each(files)('%s: relative links and anchors resolve', async (file) => {
    const markdown = await readFile(join(ROOT, file), 'utf8');
    expect(await linkProblems(file, markdown)).toEqual([]);
  });

  test.each(files)('%s: every PINWALL_ name is a setting', async (file) => {
    const markdown = await readFile(join(ROOT, file), 'utf8');
    expect(unknownSettings(markdown)).toEqual([]);
  });
});

describe('required contents', () => {
  test('the README has the install and connect commands', async () => {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(
      'docker run -v pinwall:/data -p 8080:8080 ghcr.io/dungnguyenv/pinwall',
    );
    expect(readme).toContain('claude mcp add --transport http pinwall');
  });

  test('the changelog has a 1.0.0 section', async () => {
    const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^## 1\.0\.0$/m);
  });

  test('the open-instance guide gives the settings, the order and the abuse workflow', async () => {
    const guide = await readFile(join(ROOT, 'docs/open-instance.md'), 'utf8');
    for (const line of [
      'PINWALL_VISIBILITY=personal',
      'PINWALL_SHARE_LINKS=approved',
      'PINWALL_QUOTA_BYTES=500MB',
      'PINWALL_QUOTA_ARTIFACTS=200',
      'PINWALL_PREVIEW_TTL=2h',
      'PINWALL_ABUSE_CONTACT=',
      'pinwall transfer --from',
    ]) {
      expect(guide, line).toContain(line);
    }
    expect(guide).toMatch(/30 days/);
    const anchors = anchorsOf(guide);
    for (const anchor of [
      'settings',
      'order-of-operations',
      'quotas-and-rate-limits',
      'who-may-share-outside-pinwall',
      'handling-an-abuse-report',
      'the-moderation-log',
      'moving-work-between-people',
      'a-separate-content-domain',
    ]) {
      expect(anchors.has(anchor), anchor).toBe(true);
    }
  });

  test('sign-in has an Open sign-up section with the Zitadel role claim and no member rule', async () => {
    const signIn = await readFile(join(ROOT, 'docs/sign-in.md'), 'utf8');
    expect(anchorsOf(signIn).has('open-sign-up')).toBe(true);
    const section = signIn.slice(signIn.indexOf('## Open sign-up'));
    expect(section).toContain('PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles');
    expect(section).toContain('PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin');
    expect(section).not.toMatch(/^PINWALL_OIDC_MEMBER_GROUPS=/m);
  });

  test('the backup guide has a section on restoring a 1.0 backup into 1.1', async () => {
    const backup = await readFile(join(ROOT, 'docs/backup.md'), 'utf8');
    expect(anchorsOf(backup).has('restoring-a-10-backup-into-11')).toBe(true);
  });

  test('the chart README lists every value of values.yaml', async () => {
    const chart = join(ROOT, 'deploy/helm/pinwall');
    const values = parse(await readFile(join(chart, 'values.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    const reference = await readFile(join(chart, 'README.md'), 'utf8');
    const missing = leafPaths(values).filter((path) => !reference.includes(`\`${path}\``));
    expect(missing).toEqual([]);
  });
});

/** The dotted paths of a values file, down to scalars, lists and empty maps. */
function leafPaths(node: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const isMap = typeof value === 'object' && value !== null && !Array.isArray(value);
    return isMap && Object.keys(value).length > 0
      ? leafPaths(value as Record<string, unknown>, path)
      : [path];
  });
}
