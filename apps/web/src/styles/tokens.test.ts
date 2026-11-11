import { expect, test } from 'vitest';
import indexCss from '../index.css?raw';
import tokensCss from './tokens.css?raw';

/** The text between the first `{` at or after `from` and its matching `}`. */
function blockAt(css: string, from: number): string {
  const open = css.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces');
}

function tokenNames(css: string): string[] {
  return [...css.matchAll(/(--pw-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string);
}

const lightRoot = blockAt(tokensCss, tokensCss.indexOf(':root'));
const darkStart = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = darkStart === -1 ? '' : blockAt(tokensCss, darkStart);
const lightNames = tokenNames(lightRoot);

test('the light root declares both color schemes and the full color set', () => {
  expect(lightRoot).toMatch(/color-scheme:\s*light dark/);
  for (const name of ['canvas', 'fg', 'primary', 'accent', 'danger-soft', 'overlay']) {
    expect(lightNames).toContain(`--pw-${name}`);
  }
});

test('every light token is redefined for dark mode', () => {
  expect(darkStart).toBeGreaterThan(-1);
  const darkNames = tokenNames(darkBlock);
  expect(new Set(darkNames)).toEqual(new Set(lightNames));
  expect(darkNames).toHaveLength(lightNames.length);
});

test('index.css maps every token to a Tailwind color and turns the default palette off', () => {
  expect(indexCss).toContain('@import "./styles/tokens.css"');
  expect(indexCss).toContain('--color-*: initial');
  for (const name of lightNames) {
    expect(indexCss).toContain(`--color-${name.slice('--pw-'.length)}: var(${name});`);
  }
});
