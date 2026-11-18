/**
 * The types of `match.ts` for a typecheck without the DOM (the server's): see `match.ts`.
 * `test/match.test.ts` fails when they differ from what `match.ts` exports.
 */
import type { Quote } from '@pinwall/shared/protocol';

export declare function findQuote(text: string, q: Quote): { start: number; end: number } | null;
export declare function isCssPath(selector: string): boolean;
