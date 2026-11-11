import type { ContentGrantRow, VersionRow } from '../db/schema.ts';

/**
 * Rewrites an HTML file of a review grant before it is served. `path` is the stored path of the
 * file and `baseUrl` the grant's base URL in the current isolation mode. Raw grants never pass
 * through it.
 */
export type HtmlTransform = (
  html: Buffer,
  ctx: { grant: ContentGrantRow; version: VersionRow; path: string; baseUrl: string },
) => Buffer | Promise<Buffer>;

/** A file Pinwall serves inside every grant, under `__pinwall/`. */
export interface ReservedAsset {
  contentType: string;
  body(): Buffer;
}

/** The seams of the content router that later work fills. */
export interface ContentHooks {
  transformReviewHtml?: HtmlTransform;
  /** Keyed by the path under `__pinwall/`, e.g. `markdown.css`. */
  reservedAssets?: Record<string, ReservedAsset>;
}

/**
 * The hooks `buildApp` mounts. Empty in M4: review grants are served unmodified and nothing
 * answers under `__pinwall/` yet.
 */
export const contentHooks: ContentHooks = {};
