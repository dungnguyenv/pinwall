// @vitest-environment node
// esbuild's API checks its own Uint8Arrays, which jsdom's globals would replace.

import { isAbsolute } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, expect, test } from 'vitest';
import { bundleAnnotator, bundleAnnotatorWithInputs } from '../bundle.mjs';

const PAGE =
  '<!doctype html><html><head><script data-pinwall-annotator src="http://localhost:8080/c/tok/__pinwall/annotator.js"></script></head><body><p>x</p></body></html>';

let code = '';

beforeAll(async () => {
  code = await bundleAnnotator();
});

/** A fresh window at the entry page of grant `c/tok`, whose scripts only the test runs. */
function freshWindow(): Window & typeof globalThis {
  return new JSDOM(PAGE, { url: 'http://localhost:8080/c/tok/', runScripts: 'outside-only' })
    .window;
}

test('the bundle is one IIFE under 100 kB that boots in a fresh window', () => {
  expect(code).not.toMatch(/^\s*(import|export)\b/m);
  expect(new TextEncoder().encode(code).byteLength).toBeLessThan(100_000);
  const win = freshWindow();
  try {
    const before = new Set(Object.getOwnPropertyNames(win));
    win.eval(code);
    expect(Object.getOwnPropertyNames(win).filter((k) => !before.has(k))).toEqual([
      '__pinwallAnnotator',
    ]);
  } finally {
    win.close();
  }
});

test('the bundled annotator answers its viewer without building code from strings', async () => {
  const win = freshWindow();
  try {
    const posted: unknown[] = [];
    win.postMessage = ((message: unknown) => posted.push(message)) as typeof win.postMessage;
    let compiled = 0;
    const NativeFunction = win.Function;
    win.Function = new Proxy(NativeFunction, {
      construct(target, args) {
        compiled++;
        return Reflect.construct(target, args);
      },
      apply(target, self, args) {
        compiled++;
        return Reflect.apply(target, self, args);
      },
    });
    win.eval(code);
    expect(posted).toMatchObject([{ pinwall: 1, type: 'ready', page: '' }]);
    const anchor = {
      page: '',
      kind: 'text',
      quote: { exact: 'x', prefix: '', suffix: '' },
      position: { x: 0, y: 0 },
      viewport: { width: 0 },
    };
    win.dispatchEvent(
      new win.MessageEvent('message', {
        data: {
          pinwall: 1,
          type: 'show-anchors',
          anchors: [{ id: 'c1', number: 1, resolved: false, anchor }],
        },
        source: win,
      }),
    );
    expect(posted.at(-1)).toMatchObject({
      type: 'anchors-placed',
      results: [{ id: 'c1', found: true }],
    });
    expect(compiled).toBe(0);
  } finally {
    win.close();
  }
});

test('the bundle keeps zod settings private and uses no console, storage, network or innerHTML', async () => {
  const readable = await bundleAnnotator({ minify: false });
  expect(readable).not.toMatch(/\bglobalThis\b/);
  expect(readable).not.toMatch(/\b(?:console|localStorage|sessionStorage|fetch|XMLHttpRequest)\b/);
  expect(readable).not.toMatch(/\.innerHTML\b/);
  expect(code.length).toBeLessThan(readable.length);
});

test('the bundle can report the files it was built from, as absolute paths', async () => {
  const { code: bundled, inputs } = await bundleAnnotatorWithInputs();
  expect(bundled).toBe(code);
  expect(inputs.every((input) => isAbsolute(input))).toBe(true);
  expect(inputs.some((input) => input.endsWith('/packages/annotator/src/index.ts'))).toBe(true);
  // zod is bundled as zod/mini, so its files are among the inputs.
  expect(inputs.some((input) => /\/node_modules\/zod\//.test(input))).toBe(true);
});
