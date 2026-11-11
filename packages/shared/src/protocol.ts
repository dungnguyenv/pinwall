/**
 * The messages the review viewer (the Pinwall app) and the annotator (a script Pinwall adds to
 * each HTML page of a review grant) exchange with `postMessage`, and the anchor that ties a
 * comment thread to a spot of one page.
 *
 * Contract:
 * - The annotator is served at `<grant base>/__pinwall/annotator.js` and defines exactly one
 *   global, `window.__pinwallAnnotator`. It acts only on messages whose `event.source` is
 *   `window.top` and that pass `ViewerToPageMessage`.
 * - The viewer accepts a message only when `event.source` is its review frame's window or a frame
 *   inside it, and only when it passes `PageToViewerMessage`. Every message carries `pinwall: 1`.
 * - Each frame of a review grant posts `ready` once its DOM is loaded (DOMContentLoaded). The
 *   viewer binds that `frameId` to the message's `event.source`, and sends `set-mode`,
 *   `show-anchors` and `focus-anchor` only to frame windows that posted a valid `ready`; each
 *   frame gets only the anchors of the page it named in `ready` or its latest `navigated`. Frames
 *   that never post `ready` (third-party embeds, CSP-blocked frames) receive nothing. Any frame
 *   under the review frame can still post a `ready` naming a page and so learn that page's quotes.
 * - An annotator ignores viewer messages that arrive before it has posted `ready`, and draws only
 *   the anchors of its own page.
 * - Each annotator keeps the anchors whose `page` is its own page and always answers with
 *   `anchors-placed`, listing every anchor it kept and `via`, how it placed it: by its quote, its
 *   DOM path, or its stored position. `found` is true for a point anchor, for a text anchor placed
 *   by its quote, for an element anchor placed by its DOM path, and for a text anchor placed by
 *   its DOM path only while that element's text still holds the quote (whitespace and Unicode
 *   normalized); otherwise the pin sits at the element or the position, and `found` is false.
 * - A frame that has not posted `ready` within 3 seconds of its `load` event has no annotator
 *   (its own Content-Security-Policy may block the script). For the top content frame the viewer
 *   places point comments on its own overlay; a nested frame without an annotator cannot be
 *   commented on in v1.
 * - The viewer sends anchors, pin numbers and resolved flags to pages, never comment bodies.
 *
 * The schemas use only the functional API that `zod` and `zod/mini` share (`z.optional(s)`,
 * `s.check(z.maxLength(n))`, no chained `.max()` or `.optional()`): the annotator bundle builds
 * these same schemas with `zod/mini` to stay small, while the server and the app use `zod`.
 */
import * as z from 'zod';

export const PROTOCOL_VERSION = 1;
/** The annotator script, relative to a grant's base URL. */
export const ANNOTATOR_PATH = '__pinwall/annotator.js';
/** The one property the annotator defines on `window`. */
export const ANNOTATOR_GLOBAL = '__pinwallAnnotator';

/** Characters of context kept on each side of a quoted text. */
export const QUOTE_CONTEXT_CHARS = 32;
/** Longest quoted text. */
export const QUOTE_MAX_CHARS = 2000;
/** Longest CSS selector path of an element anchor. */
export const DOM_PATH_MAX_CHARS = 2000;
/** Most anchors one message carries. */
export const MAX_ANCHORS = 1000;

/** Longest page path of an anchor or message. */
export const PAGE_MAX_CHARS = 1024;
/** Widest frame an anchor records, in CSS pixels. */
const VIEWPORT_MAX_WIDTH = 100_000;

/** A comment or frame id inside a message. */
const MessageId = z.string().check(z.minLength(1), z.maxLength(64));

/**
 * The frame's path under the grant base, decoded and NFC, with a final `index.html` dropped:
 * `""` is the entry page, `"docs/"` is `docs/index.html`.
 */
const PagePath = z.string().check(z.maxLength(PAGE_MAX_CHARS));

/** The text a comment points at, with a little of the text before and after it. */
export const Quote = z.object({
  exact: z.string().check(z.minLength(1), z.maxLength(QUOTE_MAX_CHARS)),
  prefix: z.string().check(z.maxLength(QUOTE_CONTEXT_CHARS)),
  suffix: z.string().check(z.maxLength(QUOTE_CONTEXT_CHARS)),
});
export type Quote = z.infer<typeof Quote>;

/** A fraction of the document's scroll size, 0 at the top or left edge and 1 at the other. */
const Fraction = z.number().check(z.gte(0), z.lte(1));

/**
 * Where on a page a comment thread sits. A `text` anchor needs `quote`, an `element` anchor needs
 * `dom`; `position` is the fallback every kind has, and a `point` anchor has nothing else.
 */
export const Anchor = z
  .object({
    page: PagePath,
    kind: z.enum(['text', 'element', 'point']),
    quote: z.optional(Quote),
    /** A CSS selector path from `<body>`. */
    dom: z.optional(
      z.object({ path: z.string().check(z.minLength(1), z.maxLength(DOM_PATH_MAX_CHARS)) }),
    ),
    position: z.object({ x: Fraction, y: Fraction }),
    /** The frame's width when the anchor was made. */
    viewport: z.object({
      width: z.number().check(z.int(), z.gte(0), z.lte(VIEWPORT_MAX_WIDTH)),
    }),
  })
  .check(
    z.superRefine((anchor, ctx) => {
      if (anchor.kind === 'text' && anchor.quote === undefined) {
        ctx.addIssue({ code: 'custom', path: ['quote'], message: 'A text anchor needs a quote' });
      }
      if (anchor.kind === 'element' && anchor.dom === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dom'],
          message: 'An element anchor needs a DOM path',
        });
      }
    }),
  );
export type Anchor = z.infer<typeof Anchor>;

/** How an annotator placed an anchor: by its quote, its DOM path, or its stored position. */
const PlacedVia = z.enum(['quote', 'dom', 'position']);

/** Fields of every message, in either direction. */
const envelope = { pinwall: z.literal(PROTOCOL_VERSION) };

/** What an annotator tells the viewer. */
export const PageToViewerMessage = z.discriminatedUnion('type', [
  /** The annotator of this frame is running. */
  z.object({ ...envelope, type: z.literal('ready'), page: PagePath, frameId: MessageId }),
  /** In comment mode, the reviewer chose a spot for a new thread. */
  z.object({ ...envelope, type: z.literal('anchor-picked'), anchor: Anchor, frameId: MessageId }),
  /** The answer to `show-anchors`: which of this page's anchors re-attached. */
  z.object({
    ...envelope,
    type: z.literal('anchors-placed'),
    results: z
      .array(z.object({ id: MessageId, found: z.boolean(), via: z.optional(PlacedVia) }))
      .check(z.maxLength(MAX_ANCHORS)),
    frameId: MessageId,
  }),
  /** The reviewer clicked the pin of thread `id`. */
  z.object({ ...envelope, type: z.literal('pin-clicked'), id: MessageId }),
  /** The frame now shows another page of the grant without a reload. */
  z.object({ ...envelope, type: z.literal('navigated'), page: PagePath, frameId: MessageId }),
]);
export type PageToViewerMessage = z.infer<typeof PageToViewerMessage>;

/** What the viewer tells the annotators. */
export const ViewerToPageMessage = z.discriminatedUnion('type', [
  /** `comment` turns clicks into `anchor-picked`; `browse` leaves the page alone. */
  z.object({ ...envelope, type: z.literal('set-mode'), mode: z.enum(['browse', 'comment']) }),
  /** Every thread's anchor, for each annotator to keep those of its own page. */
  z.object({
    ...envelope,
    type: z.literal('show-anchors'),
    anchors: z
      .array(
        z.object({
          id: MessageId,
          number: z.number().check(z.int(), z.gte(1)),
          resolved: z.boolean(),
          anchor: Anchor,
        }),
      )
      .check(z.maxLength(MAX_ANCHORS)),
  }),
  /** Scroll to the pin of thread `id` and highlight it. */
  z.object({ ...envelope, type: z.literal('focus-anchor'), id: MessageId }),
]);
export type ViewerToPageMessage = z.infer<typeof ViewerToPageMessage>;

/** `data` as a page-to-viewer message, or null when it is not one. */
export function parsePageMessage(data: unknown): PageToViewerMessage | null {
  const parsed = PageToViewerMessage.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** `data` as a viewer-to-page message, or null when it is not one. */
export function parseViewerMessage(data: unknown): ViewerToPageMessage | null {
  const parsed = ViewerToPageMessage.safeParse(data);
  return parsed.success ? parsed.data : null;
}
