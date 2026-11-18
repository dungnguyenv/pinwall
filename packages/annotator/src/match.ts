/**
 * What the server takes from the annotator to locate a comment in a page's source
 * (`apps/server/src/content/locate.ts`): the quote search and the shape of the paths the
 * annotator writes, as the page uses them. Both are pure string work and run in Node.
 *
 * The server's typecheck has no DOM, and these modules' neighbours in the import graph name DOM
 * types, so `@pinwall/annotator/match` declares its types in `match-types.d.ts`, which
 * `test/match.test.ts` holds to these exports.
 */
export { isCssPath } from './css-path.ts';
export { findQuote } from './quote.ts';
