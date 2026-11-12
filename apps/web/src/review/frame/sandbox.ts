/**
 * The review frame's attributes, exactly as the roadmap's security model sets
 * them. The artifact runs scripts, forms, popups and media as on its raw link,
 * but never with `allow-same-origin` (it stays an opaque origin, away from the
 * app's cookies and storage) nor `allow-top-navigation*` (it cannot move the
 * app). Camera, microphone and location are never delegated.
 */
export const CONTENT_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
export const CONTENT_ALLOW = 'fullscreen; autoplay; picture-in-picture; clipboard-write';

/** A content frame that has not posted `ready` this long after its `load` has no annotator. */
export const READY_TIMEOUT_MS = 3000;
