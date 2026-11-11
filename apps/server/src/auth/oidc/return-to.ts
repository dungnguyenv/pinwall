const MAX_LENGTH = 2048;
const OIDC_ROUTES = '/auth/oidc/';

/** C0 controls and DEL: URL parsers drop tabs and newlines, which hides `/\t/evil` tricks. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Whether the path lands on a sign-in route, however it is spelled, so sign-in never loops. */
function isOidcRoute(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: check the path as it is.
  }
  return [pathname, decoded].some((p) => p.toLowerCase().startsWith(OIDC_ROUTES));
}

/**
 * Where to send the browser after sign-in: `raw` when it is a same-origin relative path, else
 * `/`. The path must start with a single `/`, hold no `\` and no control characters, be at most
 * 2048 characters, stay on `publicOrigin` and not lead back into `/auth/oidc/`. The result is
 * the normalized path, query and fragment, checked again: dot segments can turn `/.//evil` into
 * `//evil`, which a browser reads as another host.
 */
export function safeReturnTo(raw: string | null | undefined, publicOrigin: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return '/';
  if (!isSingleSlashPath(raw) || raw.includes('\\') || hasControlCharacter(raw)) return '/';
  const origin = new URL(publicOrigin).origin;
  const url = URL.parse(raw, origin);
  if (url === null || url.origin !== origin || isOidcRoute(url.pathname)) return '/';
  const path = url.pathname + url.search + url.hash;
  return isSingleSlashPath(path) && path.length <= MAX_LENGTH ? path : '/';
}

/** Starts with one `/`, not `//` or `/\`, so no browser resolves it to another host. */
function isSingleSlashPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}
