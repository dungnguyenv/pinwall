import { defineConfig } from 'vitest/config';

/**
 * Database suites run every test on SQLite and, with the test stack, on Postgres; under parallel
 * load a Postgres test (a new database, migrations, scrypt) can pass the 5 s default.
 */
const DB_TIMEOUT_MS = 20_000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: DB_TIMEOUT_MS,
    hookTimeout: DB_TIMEOUT_MS,
  },
});
