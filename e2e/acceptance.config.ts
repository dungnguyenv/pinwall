import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The acceptance specs: the built image (`PINWALL_ACCEPTANCE_IMAGE`, by default
 * `pinwall:acceptance`, which `pnpm test:acceptance` builds) run in Docker the way the README
 * says, and the Postgres + S3 Compose example. Each spec starts and removes its own containers.
 */
export default defineConfig({
  testDir: join(import.meta.dirname, 'acceptance'),
  testMatch: '*.spec.ts',
  // One install at a time: the install spec takes port 8080, as the spec's command does.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: join(import.meta.dirname, 'test-results', 'acceptance'),
  reporter: [
    ['list'],
    ['html', { outputFolder: join(import.meta.dirname, 'report', 'acceptance'), open: 'never' }],
  ],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
