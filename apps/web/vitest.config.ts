import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    // Every test file runs in its own jsdom worker, and the root `pnpm test`
    // runs all packages at once: under that load a test or a hook that takes
    // 5 s alone can pass the default limit. Failures still report; they just
    // wait for a genuinely stuck test.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Vitest blanks CSS imports by default; let `?raw` imports through so the
    // token tests can read the stylesheets as text.
    css: { include: [/\.css\?raw$/] },
  },
});
