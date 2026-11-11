import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    // Vitest blanks CSS imports by default; let `?raw` imports through so the
    // token tests can read the stylesheets as text.
    css: { include: [/\.css\?raw$/] },
  },
});
