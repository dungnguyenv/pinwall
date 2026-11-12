import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PINWALL_E2E_PORT ?? 18087);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: '*.spec.ts',
  // The review suite has servers and a config of its own (review.config.ts).
  testIgnore: 'review/**',
  // One server, one owner account, one walk after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  outputDir: join(import.meta.dirname, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: join(import.meta.dirname, 'report'), open: 'never' }],
  ],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: join(import.meta.dirname, 'support', 'global-setup.ts'),
  globalTeardown: join(import.meta.dirname, 'support', 'global-teardown.ts'),
});
