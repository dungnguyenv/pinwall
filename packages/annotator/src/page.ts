/**
 * Which page of a grant a frame shows: its path under the grant base, the `page` every anchor
 * and message carries.
 */
import { ANNOTATOR_PATH } from '@pinwall/shared/protocol';

const INDEX = 'index.html';

/** `href` parsed, without its query and fragment; null when it is not an absolute URL. */
function bareUrl(href: string): string | null {
  try {
    const url = new URL(href);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The grant base the annotator was served from: its script URL without the trailing
 * `__pinwall/annotator.js` (and without any query or fragment). Null for any other URL.
 */
export function grantBase(scriptSrc: string): string | null {
  const href = bareUrl(scriptSrc);
  if (href === null || !href.endsWith(`/${ANNOTATOR_PATH}`)) return null;
  return href.slice(0, href.length - ANNOTATOR_PATH.length);
}

/**
 * The page `href` shows, relative to `base`: its path after the base, each segment
 * percent-decoded (a segment that does not decode stays as it is), in NFC, with a final
 * `index.html` dropped (`""` is the entry page, `"docs/"` is `docs/index.html`). Null when `href`
 * is not under `base`.
 */
export function pageOf(href: string, base: string): string | null {
  const url = bareUrl(href);
  const root = bareUrl(base);
  if (url === null || root === null || !url.startsWith(root)) return null;
  const page = url.slice(root.length).split('/').map(decodeSegment).join('/').normalize('NFC');
  if (page === INDEX) return '';
  return page.endsWith(`/${INDEX}`) ? page.slice(0, page.length - INDEX.length) : page;
}
