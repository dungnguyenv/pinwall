import { buildApp } from '../../src/app.ts';
import type { ContentHooks } from '../../src/content/hooks.ts';
import type { TestContext } from './context.ts';

/** Content-domain mode: the app on `pinwall.test`, each grant on `<token>.pw-content.test`. */
export const CONTENT_ENV = {
  PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test',
  PINWALL_ISOLATION: 'content-domain',
  PINWALL_CONTENT_ORIGIN: 'https://pw-content.test',
};

/**
 * Requests `path` (as written: percent-encoding and query kept) inside the grant `token`, where
 * the current isolation mode serves it: under `/c/<token>/` on the app origin, or at the root
 * of the grant's own content host.
 */
export async function fetchContent(
  ctx: TestContext,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { isolation } = ctx.deps.config;
  if (isolation.mode === 'single-domain') return ctx.request(`/c/${token}/${path}`, init);
  const { scheme, host, port } = isolation.contentOrigin;
  const origin = `${scheme}://${token}.${host}${port === undefined ? '' : `:${port}`}`;
  return ctx.app.request(`${origin}/${path}`, init);
}

/** The same context with an app whose content router uses `hooks` instead of the shipped ones. */
export function withContentHooks(ctx: TestContext, hooks: ContentHooks): TestContext {
  const app = buildApp(ctx.deps, { contentHooks: hooks });
  return {
    ...ctx,
    app,
    request: async (path, init) => {
      const url = /^https?:\/\//.test(path)
        ? path
        : new URL(path, ctx.deps.config.publicOrigin).href;
      return app.request(url, init);
    },
  };
}
