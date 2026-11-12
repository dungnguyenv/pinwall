import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Signing in through a real Keycloak. Global setup starts it in Docker with the realm in
 * `realm.json`, and Pinwall against it on 18096, the port the realm's client registers.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.spec.ts',
  // One Keycloak, one Pinwall, one walk after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // Keycloak's first sign-in warms up slowly, and every walk crosses it twice.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(import.meta.dirname, '..', 'test-results', 'keycloak'),
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: join(import.meta.dirname, '..', 'report', 'keycloak'), open: 'never' },
    ],
  ],
  use: {
    baseURL: 'http://localhost:18096',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: join(import.meta.dirname, 'global-setup.ts'),
  globalTeardown: join(import.meta.dirname, 'global-teardown.ts'),
});
