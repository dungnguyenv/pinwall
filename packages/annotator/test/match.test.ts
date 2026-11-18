import { expect, expectTypeOf, test } from 'vitest';
import * as match from '../src/match.ts';
import type * as Declared from '../src/match-types.d.ts';

test('the declarations the server checks against are those of match.ts', () => {
  expectTypeOf(match.findQuote).toEqualTypeOf<typeof Declared.findQuote>();
  expectTypeOf(match.isCssPath).toEqualTypeOf<typeof Declared.isCssPath>();
  expect(Object.keys(match).sort()).toEqual(['findQuote', 'isCssPath']);
});
