import { Parser } from 'htmlparser2';
import type { HtmlTransform } from './hooks.ts';

/**
 * The annotator's script element, verbatim (roadmap, Security model). `baseUrl` is a grant's base
 * URL as `contentBaseUrl` builds it: an origin and a token path, ending in `/`, so it holds
 * nothing an attribute value would need escaped.
 */
export function annotatorTag(baseUrl: string): string {
  return `<script src="${baseUrl}__pinwall/annotator.js" data-pinwall-annotator></script>`;
}

/**
 * How far into a document the scan for the injection point reads. A head that runs on past it
 * (megabytes of inline script or markup before the body) gets no tag: a policy could follow,
 * and the scan must stay cheap on a file of up to `PINWALL_MAX_FILE_BYTES`.
 */
export const HEAD_SCAN_MAX_BYTES = 16_000_000;

/** The scan feeds the parser this many bytes at a time, and stops between chunks once it knows. */
const SCAN_CHUNK_BYTES = 65_536;

/**
 * The start tags the HTML parser keeps in the head (WHATWG HTML, the "in head" insertion mode,
 * which "after head" also sends them to). Any other start tag begins the body.
 */
const HEAD_ELEMENTS = new Set([
  'base',
  'basefont',
  'bgsound',
  'head',
  'html',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);

/** Head elements whose content the browser reads as text, never as markup. */
const TEXT_ELEMENTS = new Set(['noframes', 'script', 'style', 'title']);

/** Characters that are not HTML whitespace: text holding one begins the body. */
const NOT_WHITESPACE = /[^\t\n\f\r ]/;

const CSP = 'content-security-policy';

/**
 * The byte offset where the annotator tag goes, or null to leave the document as it is: a UTF-16
 * document (its BOM starts it, and the bytes of an ASCII tag would not be text in it), or one
 * whose head runs past `HEAD_SCAN_MAX_BYTES`.
 *
 * The bytes are read as Latin-1, one character per byte, so the parser's offsets are byte
 * offsets whatever the encoding. Until the head ends, the offset moves to just after each
 * doctype, `<html>`, `<head>` and `<meta http-equiv="Content-Security-Policy">`, so the tag lands
 * after the last policy the page sets and never before its doctype. The head ends, as it does in
 * the browser, at the first start tag that belongs in the body or at text that is not
 * whitespace; `</head>` does not end it, since head elements written after it still go into the
 * head. Comments, the text of `<script>`, `<style>`, `<title>` and `<noframes>`, and the content
 * of `<noscript>` (text when scripts run) and `<template>` (inert) are passed over. With nothing
 * found, the tag goes after a UTF-8 BOM, else at byte 0.
 */
export function injectionOffset(html: Buffer): number | null {
  const utf16 = (html[0] === 0xff && html[1] === 0xfe) || (html[0] === 0xfe && html[1] === 0xff);
  if (utf16) return null;
  const start = html[0] === 0xef && html[1] === 0xbb && html[2] === 0xbf ? 3 : 0;

  let found = 0;
  let headEnded = false;
  /** The open element whose content is text to the browser, if any. */
  let textElement: string | null = null;
  /** The `<noscript>` or `<template>` being passed over, and how many templates deep. */
  let skipped: { name: string; depth: number } | null = null;

  const parser = new Parser(
    {
      onprocessinginstruction(name) {
        if (!headEnded && skipped === null && name === '!doctype') found = parser.endIndex + 1;
      },
      onopentag(name, attribs, isImplied) {
        // htmlparser2 invents an open tag for a stray `</p>` or `</br>`; the browser does not.
        if (headEnded || isImplied) return;
        if (skipped !== null) {
          if (name === 'template' && skipped.name === 'template') skipped.depth++;
          return;
        }
        if (!HEAD_ELEMENTS.has(name)) return endHead();
        if (name === 'noscript' || name === 'template') {
          skipped = { name, depth: 1 };
        } else if (TEXT_ELEMENTS.has(name)) {
          textElement = name;
        } else if (
          name === 'html' ||
          name === 'head' ||
          (name === 'meta' && attribs['http-equiv']?.toLowerCase() === CSP)
        ) {
          found = parser.endIndex + 1;
        }
      },
      onclosetag(name) {
        if (skipped !== null) {
          if (name === skipped.name && --skipped.depth === 0) skipped = null;
        } else if (name === textElement) {
          textElement = null;
        }
      },
      ontext(text) {
        if (headEnded || skipped !== null || textElement !== null) return;
        if (NOT_WHITESPACE.test(text)) endHead();
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  const endHead = () => {
    headEnded = true;
    parser.pause();
  };

  const limit = Math.min(html.length, start + HEAD_SCAN_MAX_BYTES);
  for (let at = start; at < limit && !headEnded; at += SCAN_CHUNK_BYTES) {
    parser.write(html.toString('latin1', at, Math.min(limit, at + SCAN_CHUNK_BYTES)));
  }
  if (!headEnded && limit < html.length) return null;
  return start + found;
}

/**
 * The review grants' HTML transform: splices `annotatorTag(baseUrl)` in at `injectionOffset`,
 * every other byte as stored; a document it leaves alone comes back as the same buffer.
 */
export const injectAnnotator: HtmlTransform = (html, { baseUrl }) => {
  const at = injectionOffset(html);
  if (at === null) return html;
  return Buffer.concat([
    html.subarray(0, at),
    Buffer.from(annotatorTag(baseUrl)),
    html.subarray(at),
  ]);
};
