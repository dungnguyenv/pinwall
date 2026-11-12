import { expect, test } from 'vitest';
import { satisfiesLicense } from '../src/spdx.ts';

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause']);

test.each([
  ['MIT', true],
  ['(MIT OR GPL-3.0-only)', true],
  ['MIT AND GPL-2.0-only', false],
  ['Apache-2.0 WITH LLVM-exception', true],
  ['GPL-2.0+', false],
  ['mit', true],
  ['UNLICENSED', false],
  ['SEE LICENSE IN LICENSE.md', false],
  ['', false],
  ['(MIT', false],
])('satisfiesLicense(%j) is %s', (expression, ok) => {
  expect(satisfiesLicense(expression, ALLOWED)).toBe(ok);
});

test.each([
  ['MIT+', true],
  ['  MIT  ', true],
  ['GPL-3.0-only OR MIT', true],
  ['GPL-3.0-only OR LGPL-2.1-only', false],
  ['MIT AND ISC', true],
  ['MIT AND (ISC OR GPL-3.0-only)', true],
  ['(GPL-3.0-only OR MIT) AND Apache-2.0', true],
  ['(GPL-3.0-only OR LGPL-2.1-only) AND MIT', false],
  ['GPL-3.0-only OR MIT AND ISC', true],
  ['GPL-3.0-only OR GPL-2.0-only AND MIT', false],
  ['MIT or Apache-2.0', true],
  ['GPL-2.0-only WITH Classpath-exception-2.0', false],
  ['BSD-3-clause', true],
  ['LicenseRef-Custom', false],
])('satisfiesLicense(%j) combines its parts as %s', (expression, ok) => {
  expect(satisfiesLicense(expression, ALLOWED)).toBe(ok);
});

test.each([
  'MIT)',
  'MIT AND',
  'OR MIT',
  'MIT WITH',
  'MIT WITH WITH',
  'MIT MIT',
  'Apache 2.0',
  '()',
  'MIT OR OR ISC',
  '(MIT))',
  'MIT; rm -rf /',
])('satisfiesLicense(%j) is false for text that is not an expression', (expression) => {
  expect(satisfiesLicense(expression, ALLOWED)).toBe(false);
});
