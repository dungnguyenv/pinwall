/*
 * The v1 acceptance run: every item of the design's §9 checklist, automated where it can be.
 *
 *   tsx src/acceptance.ts
 *
 * It builds the image (`docker build -t pinwall:acceptance .`) unless PINWALL_ACCEPTANCE_IMAGE
 * names one built already, then runs each suite that proves an item, each command once, from
 * the repository root. It prints a table of the items with their results and the manual checks
 * that complete them (docs/acceptance.md), writes the same table to e2e/acceptance-report.md,
 * and exits 1 when the build or any suite failed.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** The tag the run builds, and the one the acceptance specs use unless told otherwise. */
export const IMAGE = 'pinwall:acceptance';

/** Where the run leaves its report, relative to the repository root (git-ignored). */
export const REPORT_PATH = 'e2e/acceptance-report.md';

export type ItemId = '1' | '2' | '3' | '3a' | '3b' | '4' | '5' | '6' | '7' | '8' | '9' | '10';

/** A suite that proves an item, run from the repository root. */
export interface AutomatedCheck {
  label: string;
  command: readonly string[];
}

/**
 * One item of the spec's acceptance list. `manual` holds the headings (slugs) of
 * docs/acceptance.md whose checks complete it: the parts that need a real IdP, a real Claude
 * client or a public https origin. It is empty when the suites prove the whole item.
 */
export interface AcceptanceItem {
  id: ItemId;
  title: string;
  automated: readonly AutomatedCheck[];
  manual: readonly string[];
}

export type Result = 'pass' | 'fail';

const serverSuite = (label: string, ...files: string[]): AutomatedCheck => ({
  label,
  command: ['pnpm', '--filter', '@pinwall/server', 'exec', 'vitest', 'run', ...files],
});

const ACCEPTANCE_SPECS: AutomatedCheck = {
  label: 'acceptance specs on the built image',
  command: ['pnpm', 'exec', 'playwright', 'test', '-c', 'e2e/acceptance.config.ts'],
};
const AGENT_FLOW = serverSuite('MCP agent flow', 'test/mcp/agent-flow');
const OIDC_FLOW = serverSuite('OIDC flow', 'test/auth/oidc/flow');
const KEYCLOAK: AutomatedCheck = {
  label: 'real Keycloak sign-in',
  command: ['pnpm', 'test:e2e:keycloak'],
};
const BROWSER_REVIEW: AutomatedCheck = {
  label: 'browser review suite',
  command: ['pnpm', 'test:e2e:review'],
};
const SERVER_FLOWS = serverSuite(
  'review and publishing flows',
  'test/api/review-flow',
  'test/api/publishing-flow',
);

export const ITEMS: readonly AcceptanceItem[] = [
  {
    id: '1',
    title: 'docker run and the setup link give a working install in under five minutes',
    automated: [ACCEPTANCE_SPECS],
    manual: ['fresh-install'],
  },
  {
    id: '2',
    title: 'Claude Code signs in through the browser and publishes ./site to a review link',
    automated: [AGENT_FLOW],
    manual: ['claude-code'],
  },
  {
    id: '3',
    title: 'OIDC with Zitadel, Keycloak and Google maps admins and members; others get no access',
    automated: [OIDC_FLOW, KEYCLOAK],
    manual: ['zitadel', 'google'],
  },
  {
    id: '3a',
    title: 'Claude Desktop publishes a single HTML file inline and gets a review link',
    automated: [AGENT_FLOW],
    manual: ['claude-desktop'],
  },
  {
    id: '3b',
    title:
      'a member removed from the IdP group loses access within 24 hours, at once on Revoke now',
    automated: [OIDC_FLOW, KEYCLOAK],
    manual: ['zitadel'],
  },
  {
    id: '4',
    title: '"read the comments and fix" moves an open review tab to v2, the comment resolved in v2',
    automated: [AGENT_FLOW, BROWSER_REVIEW],
    manual: ['review-loop'],
  },
  {
    id: '5',
    title: 'a multi-page artifact behaves the same in review as raw, in both isolation modes',
    automated: [BROWSER_REVIEW],
    manual: [],
  },
  {
    id: '6',
    title: 'a backup restores on another machine, and from SQLite + disk into Postgres + S3',
    automated: [ACCEPTANCE_SPECS],
    manual: ['two-machines'],
  },
  {
    id: '7',
    title: '"chup anh" finds an artifact containing "chụp ảnh"',
    automated: [ACCEPTANCE_SPECS],
    manual: [],
  },
  {
    id: '8',
    title: 'behind Cloudflare Tunnel, raw and share links deliver the published bytes',
    automated: [SERVER_FLOWS],
    manual: ['cloudflare-tunnel'],
  },
  {
    id: '9',
    title: 'a deleted version is gone at once, and its files leave storage unless still used',
    automated: [ACCEPTANCE_SPECS],
    manual: [],
  },
  {
    id: '10',
    title: 'switching the isolation mode and restarting keeps every link working',
    automated: [ACCEPTANCE_SPECS],
    manual: [],
  },
];

/** A command as one line of text: the key of its result. */
export function commandLine(command: readonly string[]): string {
  return command.join(' ');
}

/** The commands the items need, each identical command once, in the order items name them. */
export function uniqueCommands(items: readonly AcceptanceItem[] = ITEMS): AutomatedCheck[] {
  const seen = new Map<string, AutomatedCheck>();
  for (const check of items.flatMap((item) => item.automated)) {
    const line = commandLine(check.command);
    if (!seen.has(line)) seen.set(line, check);
  }
  return [...seen.values()];
}

/** The image build to run first, or null when PINWALL_ACCEPTANCE_IMAGE names a built image. */
export function imageBuild(env: NodeJS.ProcessEnv): string[] | null {
  return env.PINWALL_ACCEPTANCE_IMAGE ? null : ['docker', 'build', '-t', IMAGE, '.'];
}

/**
 * The results as a Markdown table, one row per item. An item passes when every command it needs
 * passed, fails when one failed, and is "not run" otherwise.
 */
export function renderReport(results: Map<string, Result>, note?: string): string {
  const rows = ITEMS.map((item) => {
    const outcomes = item.automated.map((check) => results.get(commandLine(check.command)));
    const result = outcomes.includes('fail')
      ? 'fail'
      : outcomes.every((outcome) => outcome === 'pass')
        ? 'pass'
        : 'not run';
    const automated = item.automated.map((check) => check.label).join('; ');
    const manual =
      item.manual.length === 0
        ? '—'
        : item.manual.map((slug) => `docs/acceptance.md#${slug}`).join(', ');
    return `| ${item.id} ${item.title} | ${automated} | ${result} | ${manual} |`;
  });
  return [
    '# Pinwall acceptance report',
    '',
    ...(note === undefined ? [] : [note, '']),
    '| Item | Automated by | Result | Manual check |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'Each manual check is done by hand against the built image and recorded in docs/acceptance.md.',
    '',
  ].join('\n');
}

/** Runs a command from the repository root with the run's output shown; resolves its exit code. */
export type Runner = (command: readonly string[]) => Promise<number>;

const runInherited: Runner = (command) =>
  new Promise((done) => {
    const [file = '', ...args] = command;
    const child = spawn(file, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`${commandLine(command)}: ${error.message}`);
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Runs the acceptance list; the result is the exit code. */
export async function main(
  o: { env?: NodeJS.ProcessEnv; run?: Runner; reportPath?: string } = {},
): Promise<number> {
  const env = o.env ?? process.env;
  const run = o.run ?? runInherited;
  const reportPath = o.reportPath ?? join(ROOT, REPORT_PATH);
  const results = new Map<string, Result>();
  let note: string | undefined;

  const build = imageBuild(env);
  if (build === null) console.log(`Using the image ${env.PINWALL_ACCEPTANCE_IMAGE}`);
  else {
    console.log(`\n▶ image: ${commandLine(build)}`);
    const started = Date.now();
    const code = await run(build);
    if (code !== 0) {
      note = `The image did not build (\`${commandLine(build)}\` exited with ${code}); nothing ran.`;
      console.error(note);
    } else console.log(`✔ image built in ${seconds(Date.now() - started)}`);
  }

  if (note === undefined) {
    for (const check of uniqueCommands()) {
      const line = commandLine(check.command);
      console.log(`\n▶ ${check.label}: ${line}`);
      const started = Date.now();
      const result: Result = (await run(check.command)) === 0 ? 'pass' : 'fail';
      results.set(line, result);
      console.log(
        `${result === 'pass' ? '✔' : '✘'} ${check.label}: ${result} in ${seconds(Date.now() - started)}`,
      );
    }
  }

  const report = renderReport(results, note);
  console.log(`\n${report}`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report);
  const failed = note !== undefined || [...results.values()].includes('fail');
  return failed ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
