import { expect, test } from 'vitest';
import { elementAnchor } from '../src/anchors.ts';
import { cssEscape, cssPath, isCssPath } from '../src/css-path.ts';
import { el, shadowOf } from './helpers/dom.ts';

/** `cssPath(element)`, checked to find `element` again and to have the shape `isCssPath` takes. */
function roundTrip(element: Element): string {
  const path = cssPath(element);
  if (path === null) throw new Error(`no path for ${element.outerHTML}`);
  expect(document.querySelector(path), path).toBe(element);
  expect(isCssPath(path), path).toBe(true);
  return path;
}

test('cssPath uses unique ids, and nth-of-type only where needed', () => {
  document.body.innerHTML =
    '<main><section><p>a</p><p>b</p></section><section id="price"><ul><li>x</li><li>y</li></ul></section></main>';
  expect(cssPath(el('p', 1))).toBe('body > main > section:nth-of-type(1) > p:nth-of-type(2)');
  expect(cssPath(el('li', 1))).toBe('#price > ul > li:nth-of-type(2)');
  expect(cssPath(document.body)).toBeNull();
});

test('duplicate and awkward ids', () => {
  document.body.innerHTML =
    '<div id="dup"><p>a</p></div><div id="dup"><p>b</p></div><div id="1a.b"><p>c</p></div>';
  expect(cssPath(el('p', 1))).toBe('body > div:nth-of-type(2) > p');
  expect(roundTrip(el('p', 2))).toBe('#\\31 a\\.b > p');
  expect(roundTrip(el('div', 2))).toBe('#\\31 a\\.b');

  const awkward = ['a b', 'x>y', '1', '-1', '--', '-', 'Tài', '😀', 'a\\b', `q"u'o`, '[x]', 'a\tb'];
  document.body.innerHTML = '';
  for (const id of awkward) {
    const div = document.createElement('div');
    div.id = id;
    div.append(document.createElement('p'));
    document.body.append(div);
  }
  awkward.forEach((id, i) => {
    expect(roundTrip(el('p', i))).toBe(`#${cssEscape(id)} > p`);
  });
});

test('generated-looking ids are not used', () => {
  const generated = [
    ':r1:',
    '«r2»',
    'ember1234',
    'a3f9c2e17b',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'post-1699999999',
    'mui-12',
  ];
  document.body.innerHTML = [...generated, 'pricing', 'section-2']
    .map((id) => `<div id="${id}"><p>x</p></div>`)
    .join('');
  generated.forEach((_, i) => {
    expect(roundTrip(el('p', i))).toBe(`body > div:nth-of-type(${i + 1}) > p`);
  });
  expect(roundTrip(el('p', 7))).toBe('#pricing > p');
  expect(roundTrip(el('p', 8))).toBe('#section-2 > p');
});

test('cssEscape serializes identifiers as CSSOM does', () => {
  const cases: [string, string][] = [
    ['1a.b', '\\31 a\\.b'],
    ['-', '\\-'],
    ['-1x', '-\\31 x'],
    ['--x', '--x'],
    ['a b', 'a\\ b'],
    ['\0x', '\uFFFDx'],
    ['\x01\x7f', '\\1 \\7f '],
    ['Tài_é😀', 'Tài_é😀'],
    ['a:b#c>d', 'a\\:b\\#c\\>d'],
    ['', ''],
  ];
  for (const [ident, escaped] of cases) {
    expect(cssEscape(ident)).toBe(escaped);
    // jsdom's own CSS.escape agrees, so the expectations above follow the spec.
    expect(CSS.escape(ident)).toBe(escaped);
  }
});

test('every element round-trips through querySelector', () => {
  document.body.innerHTML = `
    <header id="top"><nav><a href="#">Home</a><a href="#">Docs</a><a href="#">Blog</a></nav></header>
    <main>
      <article><h1>Title</h1><p>One <em>two</em> <strong>three</strong></p><p>Four <code>five</code></p>
        <ul><li>a</li><li>b <span>c</span></li><li>d</li></ul></article>
      <section class="x"><h2>Prices</h2><table><thead><tr><th>Plan</th><th>Cost</th></tr></thead>
        <tbody><tr><td>Free</td><td>0</td></tr><tr><td>Pro</td><td>9</td></tr></tbody></table></section>
      <section><form><label>Name <input name="n"></label>
        <select><option>x</option><option>y</option></select><button>Go</button></form></section>
      <my-widget><div><div><span>deep</span></div></div></my-widget>
      <foo:bar><i>odd tag name</i></foo:bar>
    </main>
    <footer><p>© 2026</p><img alt=""><br><svg></svg></footer>`;
  const elements = [...document.body.querySelectorAll('*')];
  expect(elements.length).toBeGreaterThanOrEqual(40);
  for (const element of elements) roundTrip(element);
});

test('elements inside svg anchor the svg', () => {
  document.body.innerHTML =
    '<div><svg id="logo" viewBox="0 0 10 10"><g><path d="M0 0h10"/></g></svg><svg><circle r="1"/></svg></div>';
  expect(elementAnchor({ doc: document, page: '' }, el('path'))?.dom?.path).toBe('#logo');
  expect(cssPath(el('circle'))).toBe('body > div > svg:nth-of-type(2)');
});

test('anything outside body, and paths that grow too long, have no path', () => {
  document.head.innerHTML = '<title>t</title>';
  document.body.innerHTML = '<div id="host"></div><template><p>t</p></template>';
  const shadow = shadowOf('#host', '<p>shadow</p>');
  const template = el('template') as HTMLTemplateElement;
  for (const outside of [
    document.documentElement,
    document.head,
    el('title'),
    document.body,
    document.createElement('p'),
    el('p', 0, shadow),
    el('p', 0, template.content),
  ]) {
    expect(cssPath(outside)).toBeNull();
  }
  document.body.innerHTML = `${'<div>'.repeat(400)}deep${'</div>'.repeat(400)}`;
  expect(roundTrip(el('div', 300))).toHaveLength('body'.length + 301 * ' > div'.length);
  expect(cssPath(el('div', 399))).toBeNull();
});
