const MAX_LENGTH = 2048;

/** C0 controls and DEL: URL parsers drop tabs and newlines, which would hide `/\t/evil`. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** One leading `/`, never `//` or `/\`, which browsers read as another host. */
function startsWithOneSlash(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Pages that must never be a destination after signing in: the OIDC routes
 * (the server's own rule) and the sign-in and setup pages, which would loop.
 * Checked in any letter case and percent-decoded, since the router matches
 * paths case-insensitively.
 */
function isSignInRoute(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: check the path as written.
  }
  return [pathname, decoded].some((path) => {
    const lower = path.toLowerCase();
    return lower.startsWith('/auth/oidc/') || isUnder(lower, '/signin') || isUnder(lower, '/setup');
  });
}

/**
 * Where to go after signing in: `raw` when it is a path on this origin, else
 * `/`. The rules match the server's `return_to` check: a single leading `/`,
 * no `\` and no control characters, at most 2048 characters, the same origin
 * once resolved, and not an OIDC route. The web app also refuses `/signin`
 * and `/setup`. The result is the normalized path, query and hash, checked
 * again because dot segments can turn `/.//evil` into `//evil`.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return '/';
  if (!startsWithOneSlash(raw) || raw.includes('\\') || hasControlCharacter(raw)) return '/';
  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return '/';
  }
  if (url.origin !== origin || isSignInRoute(url.pathname)) return '/';
  const path = url.pathname + url.search + url.hash;
  return startsWithOneSlash(path) && path.length <= MAX_LENGTH ? path : '/';
}

/** The return path of a sign-in URL: `return_to`, or `next` as M4's raw links send it. */
export function returnToFrom(search: URLSearchParams): string {
  return safeReturnTo(search.get('return_to') ?? search.get('next'));
}

export function signInPath(returnTo: string): string {
  return `/signin?return_to=${encodeURIComponent(returnTo)}`;
}

/** Starts OIDC sign-in; `selectAccount` asks the IdP to let the person pick another account. */
export function oidcStartPath(returnTo: string, selectAccount?: boolean): string {
  const prompt = selectAccount ? '&prompt=select_account' : '';
  return `/auth/oidc/start?return_to=${encodeURIComponent(returnTo)}${prompt}`;
}

const SERVER_PREFIXES = ['/api', '/auth', '/upload', '/c', '/mcp', '/.well-known'];
const RAW_LINK = /^\/a\/[^/]+\/(?:v\/\d+\/)?raw$/;

/**
 * Whether `path` is answered by the server rather than the app, so getting
 * there needs a full page load. `/oauth/consent` is the app's consent page;
 * the rest of `/oauth/` belongs to the server.
 */
export function isServerRoute(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  if (SERVER_PREFIXES.some((prefix) => isUnder(pathname, prefix))) return true;
  if (pathname.startsWith('/oauth/')) return !isUnder(pathname, '/oauth/consent');
  return RAW_LINK.test(pathname);
}
