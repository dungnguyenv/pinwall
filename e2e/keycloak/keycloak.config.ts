import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { SPACES_ORIGIN } from './support.ts';

/**
 * Signing in through a real Keycloak. Global setup starts it in Docker with the realm in
 * `realm.json`, and two Pinwalls against it on the ports the realm's client registers: 18096 in
 * team mode, which `sign-in.spec.ts` walks, and 18097 in personal mode with open sign-up, which
 * `spaces.spec.ts` walks. Each person runs in a browser context of their own, because cookies on
 * `localhost` ignore the port.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.spec.ts',
  // One Keycloak, two Pinwalls, one walk after another.
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
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'team',
      testMatch: 'sign-in.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:18096' },
    },
    {
      name: 'personal',
      testMatch: 'spaces.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: SPACES_ORIGIN },
    },
  ],
  globalSetup: join(import.meta.dirname, 'global-setup.ts'),
  globalTeardown: join(import.meta.dirname, 'global-teardown.ts'),
});
