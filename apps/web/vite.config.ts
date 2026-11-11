import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/*
 * In development the Pinwall server runs on :8080 and Vite serves the app on
 * :5173, passing the server's own paths through. Start the server with
 * PINWALL_PUBLIC_ORIGIN=http://localhost:5173 so its CSRF check accepts the
 * Origin the browser sends. The Host header is kept as the browser sent it.
 */
const SERVER = 'http://localhost:8080';
const SERVER_PATHS = [
  '/api',
  '/auth/oidc',
  '/upload',
  '/c/',
  '/mcp',
  '/.well-known',
  // OAuth endpoints only: /oauth/consent is an app page.
  '^/oauth/(authorize|token|register|revoke)',
  // Raw links, which redirect to a content grant.
  '^/a/[^/]+/(v/\\d+/)?raw',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // The framework changes rarely and the app often: one chunk of its own stays
            // cached across releases, so an upgrade of the app re-downloads only the app.
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
            },
            // zod is set to jitless by src/zod-config.ts before @pinwall/shared builds its
            // schemas. Both must sit in one chunk, or the chunk with the schemas would run
            // before the entry that configures zod.
            { name: 'zod', test: /[\\/]node_modules[\\/]zod[\\/]|[\\/]src[\\/]zod-config\.ts$/ },
          ],
        },
      },
    },
  },
  server: {
    proxy: Object.fromEntries(
      SERVER_PATHS.map((path): [string, ProxyOptions] => [
        path,
        { target: SERVER, changeOrigin: false },
      ]),
    ),
  },
});
