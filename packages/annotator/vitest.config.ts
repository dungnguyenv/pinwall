import { defineConfig } from 'vitest/config';

export default defineConfig({
  // As in the bundle (see bundle.mjs): the protocol schemas are built with zod/mini.
  resolve: { alias: [{ find: /^zod$/, replacement: 'zod/mini' }] },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
