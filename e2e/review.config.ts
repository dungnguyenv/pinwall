import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { REVIEW_SERVERS } from './support/review-servers.ts';

/**
 * The review screen against real servers, one per isolation mode. Each project runs every spec
 * against its own server (its origin is the project's `baseURL`); a spec finds the server's setup
 * link through `reviewServer(testInfo.project.name)`.
 */
export default defineConfig({
  testDir: join(import.meta.dirname, 'review'),
  testMatch: '*.spec.ts',
  // One owner account per server, one walk after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(import.meta.dirname, 'test-results', 'review'),
  reporter: [
    ['list'],
    ['html', { outputFolder: join(import.meta.dirname, 'report', 'review'), open: 'never' }],
  ],
  use: { trace: 'retain-on-failure' },
  projects: REVIEW_SERVERS.map((server) => ({
    name: server.project,
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1280, height: 800 },
      baseURL: server.origin,
    },
  })),
  globalSetup: join(import.meta.dirname, 'support', 'review-setup.ts'),
  globalTeardown: join(import.meta.dirname, 'support', 'review-teardown.ts'),
});
