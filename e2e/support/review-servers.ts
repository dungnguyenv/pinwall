/**
 * The two servers of the review suite, one per isolation mode, each named after the Playwright
 * project that runs against it. Chromium resolves every `*.localhost` name to loopback, so the
 * content-domain server needs no DNS: its app is `app.localhost` and each grant gets a host under
 * `pwc.localhost`.
 */
export const REVIEW_SERVERS = [
  {
    project: 'single-domain',
    key: 'SINGLE',
    port: 18091,
    origin: 'http://localhost:18091',
    env: {},
  },
  {
    project: 'content-domain',
    key: 'CONTENT',
    port: 18092,
    origin: 'http://app.localhost:18092',
    env: {
      PINWALL_ISOLATION: 'content-domain',
      PINWALL_CONTENT_ORIGIN: 'http://pwc.localhost:18092',
    },
  },
] as const;

export type ReviewServer = (typeof REVIEW_SERVERS)[number];

/** Where the global setup leaves a server's origin and setup link for the workers. */
export function serverEnvNames(server: ReviewServer): { origin: string; setupUrl: string } {
  return {
    origin: `PINWALL_E2E_${server.key}_ORIGIN`,
    setupUrl: `PINWALL_E2E_${server.key}_SETUP_URL`,
  };
}

/** The running server of the project named `project`, as the global setup started it. */
export function reviewServer(project: string): { origin: string; setupUrl: string } {
  const server = REVIEW_SERVERS.find((s) => s.project === project);
  if (server === undefined) throw new Error(`No review server for the project "${project}"`);
  const names = serverEnvNames(server);
  const origin = process.env[names.origin];
  const setupUrl = process.env[names.setupUrl];
  if (origin === undefined || setupUrl === undefined) {
    throw new Error(`${names.origin} is not set: run the suite with -c e2e/review.config.ts`);
  }
  return { origin, setupUrl };
}
