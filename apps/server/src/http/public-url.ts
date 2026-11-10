import type { Config } from '../config/types.ts';

/**
 * The absolute URL of `path` on `PINWALL_PUBLIC_ORIGIN`. It never looks at the request (`Host`,
 * `X-Forwarded-*`), so links, redirects and metadata are right behind any proxy or tunnel.
 * `path` must start with a single `/`; anything that could name another host is a TypeError.
 */
export function publicUrl(config: Pick<Config, 'publicOrigin'>, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw new TypeError(`publicUrl needs a path starting with a single "/", got "${path}"`);
  }
  return config.publicOrigin + path;
}
