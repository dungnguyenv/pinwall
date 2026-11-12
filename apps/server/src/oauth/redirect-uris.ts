import { MAX_REDIRECT_URI_LENGTH } from './constants.ts';

export type RedirectUriProblem =
  | 'not_a_url'
  | 'fragment'
  | 'userinfo'
  | 'insecure_http'
  | 'forbidden_scheme'
  | 'too_long';

/**
 * Schemes a browser would run, read locally or never hand to an app, so they can never be where
 * an authorization response goes.
 */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'filesystem:',
  'ws:',
  'wss:',
  'ftp:',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Spaces and control characters, which no URI contains. The URL parser quietly drops tabs and
 * newlines anywhere, and spaces and controls at either end (`java\nscript:` parses as
 * `javascript:`), so a redirect URI holding one is refused rather than read the parser's way.
 */
const WHITESPACE_OR_CONTROL = /[\p{Cc} ]/u;

/** The hostnames of RFC 8252 §7.3 loopback redirects, as `URL.hostname` spells them. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function parse(raw: string): URL | null {
  if (WHITESPACE_OR_CONTROL.test(raw)) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Whether `raw` may be registered as a redirect URI (RFC 6749 §3.1.2, RFC 8252 §7, OAuth 2.1
 * §2.3.1): https, plain http only to a loopback host, or a private-use scheme such as
 * `cursor://` or `com.example.app:`. Checked in this order: length, parse, fragment, user info,
 * forbidden scheme, plain http to another host.
 */
export function checkRedirectUri(
  raw: string,
): { ok: true } | { ok: false; problem: RedirectUriProblem } {
  if (raw.length > MAX_REDIRECT_URI_LENGTH) return { ok: false, problem: 'too_long' };
  const url = parse(raw);
  if (!url) return { ok: false, problem: 'not_a_url' };
  // `href` keeps an empty fragment's `#`, which `hash` hides.
  if (url.href.includes('#')) return { ok: false, problem: 'fragment' };
  if (url.username !== '' || url.password !== '') return { ok: false, problem: 'userinfo' };
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return { ok: false, problem: 'forbidden_scheme' };
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, problem: 'insecure_http' };
  }
  return { ok: true };
}

/** A loopback URI registered over plain http, whose port the client picks at each sign-in. */
function loopbackUrl(uri: string): URL | null {
  const url = parse(uri);
  return url?.protocol === 'http:' && isLoopbackHost(url.hostname) ? url : null;
}

/**
 * Whether `requested` is one of the client's `registered` redirect URIs: the same string, or,
 * for a registered http loopback URI, the same host, path and query on any port (RFC 8252 §7.3;
 * native apps listen on whatever port is free). `requested` must itself be a valid redirect URI.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!checkRedirectUri(requested).ok) return false;
  const asked = loopbackUrl(requested);
  if (!asked) return false;
  return registered.some((uri) => {
    const known = loopbackUrl(uri);
    return (
      known !== null &&
      known.hostname === asked.hostname &&
      known.pathname === asked.pathname &&
      known.search === asked.search
    );
  });
}

/**
 * What a page may repeat of a redirect URI it refuses: the scheme, host and path, without user
 * info, query or fragment, any of which could carry text posing as Pinwall's own words. Null when
 * `raw` is not a URL (free text, spaces or control characters included).
 */
export function displayedRedirectUri(raw: string): string | null {
  const url = parse(raw);
  if (!url) return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Where the browser goes back to, for the consent page: `host[:port]` for http(s), the scheme
 * and host for a private-use URI with one (`cursor://anysphere.cursor-mcp`), and the scheme alone
 * otherwise (`com.example.app:`). `uri` must have passed `checkRedirectUri`.
 */
export function redirectHost(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.host;
  return url.host === '' ? url.protocol : `${url.protocol}//${url.host}`;
}
