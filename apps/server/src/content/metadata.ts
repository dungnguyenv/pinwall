import { Parser } from 'htmlparser2';
import MarkdownIt, { type Token } from 'markdown-it';
import type { ArtifactKind } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { quotePath } from '../publish/paths.ts';
import { isRasterImage } from './mime.ts';
import { cssUrls, srcsetUrls } from './url-scan.ts';

/** The search text of one version never exceeds this many UTF-16 units. */
export const SEARCH_TEXT_MAX_CHARS = 200_000;
/** A version keeps at most this many publish warnings. */
export const MAX_WARNINGS = 50;
/** Per HTML/CSS file scanned for warnings: bytes beyond this are not scanned. */
export const SCAN_MAX_BYTES = 5_000_000;
/** markdown-it's inline parser needs up to ~2.6 µs per byte on hostile input, so it reads less. */
export const MARKDOWN_MAX_BYTES = 500_000;
/**
 * Bytes read in all across the files of one version for metadata and search text. The file that
 * reaches it is read only up to it, and the files after it are skipped.
 */
export const SCAN_BUDGET_BYTES = 20_000_000;

export interface PublishWarning {
  code: 'root_absolute_url';
  file: string;
  url: string;
  message: string;
}

export interface VersionMetadata {
  title: string | null;
  themeColor: string | null;
  thumbnailPath: string | null;
  text: string;
  warnings: PublishWarning[];
}

/** A file of a version as extraction sees it. */
export interface MetadataFile {
  path: string;
  contentType: string;
  size: number;
  /** The first `max` bytes of the file, or all of it when it is shorter. */
  read(max: number): Promise<Buffer>;
}

const TITLE_MAX_CHARS = 200;
const THEME_COLOR_MAX_CHARS = 64;
const THEME_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\))$/i;

/** The HTML parser is fed this many UTF-16 units at a time, and checked between writes. */
const HTML_CHUNK = 16 * 1024;
/**
 * htmlparser2 keeps open elements in an array that it unshifts, shifts and searches, so a document
 * of nothing but `<div>` costs quadratic time. Parsing stops once nesting is this deep.
 */
const HTML_MAX_DEPTH = 512;
/** Raw characters kept while a `<title>` or heading is open, before it is cleaned and cut. */
const TITLE_SCAN_CHARS = 2_000;
/** Image references remembered per entry page; thumbnails come from the first usable one. */
const IMAGE_CANDIDATES = 50;
/** A reference longer than this cannot name a stored path (512 characters, percent-encoded). */
const REF_MAX_CHARS = 8_192;
/** The URL kept in a warning; the message quotes less. */
const WARNING_URL_MAX = 200;

/** Whitespace and control characters (a NUL would fail an insert on Postgres). */
const BLANKS = /[\s\p{Cc}]+/gu;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Text-formatting elements, whose boundaries do not split a word: `Gi<b>á</b>` reads "Giá". Every
 * other element, `<a>` and `<span>` included, ends a word, so `<a>Home</a><a>About</a>` reads
 * "Home About".
 */
const FORMATTING_ELEMENTS = new Set([
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'strike',
  'strong',
  'sub',
  'sup',
  'tt',
  'u',
  'var',
  'wbr',
]);

/** Content of these is not shown as text. */
const SILENT_ELEMENTS = new Set(['script', 'style', 'template']);

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'poster', 'data', 'formaction', 'srcset']);

/** Invalid UTF-8 becomes U+FFFD, a BOM is dropped, and nothing throws. */
const decoder = new TextDecoder('utf-8');
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

/**
 * Reads what a version shows: the title, theme color and thumbnail of its entry page, the text of
 * its pages for search, and the warnings that tell the publisher a page will not load in
 * single-domain mode. Never executes or fetches anything, and never throws on malformed markup:
 * each file is read up to `SCAN_MAX_BYTES` (Markdown up to less), the version up to
 * `SCAN_BUDGET_BYTES`, and what it collects is bounded.
 */
export async function extractMetadata(
  files: readonly MetadataFile[],
  entryPath: string,
  kind: ArtifactKind,
): Promise<VersionMetadata> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const sink = new TextSink(SEARCH_TEXT_MAX_CHARS);
  const warnings = new WarningCollector();
  const probe = new EntryProbe();

  const queue = files
    .map((file) => ({
      file,
      type: file.path === entryPath ? entryType(kind) : scanTypeOf(file.path),
    }))
    .filter((item): item is { file: MetadataFile; type: ScanType } => item.type !== null)
    .sort((a, b) => compareForText(entryPath, a.file.path, b.file.path));

  let budget = SCAN_BUDGET_BYTES;
  for (const { file, type } of queue) {
    if (budget <= 0) break;
    const isEntry = file.path === entryPath;
    const wantText = type !== 'css' && !sink.full;
    const wantWarnings = type !== 'markdown' && !warnings.full;
    if (!isEntry && !wantText && !wantWarnings) continue;

    const max = Math.min(readLimit(type), budget);
    const bytes = await file.read(max);
    budget -= Math.min(bytes.length, max);
    const source = decode(bytes, max);
    if (type === 'markdown') {
      scanMarkdown(source, wantText ? sink : null, isEntry ? probe : null);
    } else if (type === 'html') {
      scanHtml(
        source,
        file.path,
        wantText ? sink : null,
        wantWarnings ? warnings : null,
        isEntry ? probe : null,
      );
    } else {
      scanStylesheet(source, file.path, warnings);
    }
  }

  return {
    title: probe.title ?? probe.heading,
    themeColor: probe.themeColor,
    thumbnailPath: probe.thumbnail(entryPath, byPath),
    text: sink.text,
    warnings: warnings.list,
  };
}

/**
 * The search text of a stored version, by the same rule as `extractMetadata`: its entry first,
 * then its other `.html`/`.htm`/`.md` files by path, up to `SEARCH_TEXT_MAX_CHARS`. Only the head
 * of each file is read, and at most `SCAN_BUDGET_BYTES` in all; unlike at publish, stylesheets do
 * not count against that budget, as they are not read here. A file whose blob is missing is
 * logged and skipped, so one lost blob does not stop a re-index.
 */
export async function extractVersionText(deps: AppDeps, versionId: string): Promise<string> {
  const rows = await deps.db.db
    .selectFrom('version_files')
    .innerJoin('versions', 'versions.id', 'version_files.version_id')
    .select([
      'version_files.path as path',
      'version_files.sha256 as sha256',
      'version_files.size as size',
      'versions.entry_path as entryPath',
    ])
    .where('version_files.version_id', '=', versionId)
    .execute();

  const sink = new TextSink(SEARCH_TEXT_MAX_CHARS);
  const pages = rows
    .map((row) => ({ row, type: scanTypeOf(row.path) }))
    .filter(
      (item): item is { row: (typeof rows)[number]; type: 'html' | 'markdown' } =>
        item.type === 'html' || item.type === 'markdown',
    )
    .sort((a, b) => compareForText(a.row.entryPath, a.row.path, b.row.path));

  let budget = SCAN_BUDGET_BYTES;
  for (const { row, type } of pages) {
    if (sink.full || budget <= 0) break;
    if (row.size <= 0) continue;
    const max = Math.min(readLimit(type), budget);
    const bytes = await readHead(deps, versionId, row, max);
    if (bytes === null) continue;
    budget -= bytes.length;
    const source = decode(bytes, max);
    if (type === 'markdown') scanMarkdown(source, sink, null);
    else scanHtml(source, row.path, sink, null, null);
  }
  return sink.text;
}

/**
 * The stored path a relative URL in `fromFile` names, or null when it does not name a file of
 * the version: an absolute URL, `//host`, `/path`, `data:` and other schemes, `#fragment`, a path
 * that climbs out of the root, or one that cannot be decoded. The query and fragment are dropped;
 * each segment is percent-decoded and NFC-normalized, and `\` counts as `/` as it does in browsers.
 */
export function resolveRef(fromFile: string, ref: string): string | null {
  if (ref.length > REF_MAX_CHARS) return null;
  const trimmed = ref.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const cut = trimmed.search(/[?#]/);
  const target = (cut === -1 ? trimmed : trimmed.slice(0, cut)).replaceAll('\\', '/');
  if (target.startsWith('/') || SCHEME.test(target)) return null;

  const stored = fromFile.split('/');
  stored.pop();
  for (const encoded of target.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded).normalize('NFC');
    } catch {
      return null;
    }
    // After decoding a segment is a name; one that holds a separator cannot be a stored path.
    if (segment === '' || segment.includes('/') || segment.includes('\\')) return null;
    if (segment === '.') continue;
    if (segment === '..') {
      if (stored.pop() === undefined) return null;
      continue;
    }
    stored.push(segment);
  }
  return stored.length === 0 ? null : stored.join('/');
}

type ScanType = 'html' | 'markdown' | 'css';

function scanTypeOf(path: string): ScanType | null {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return null;
  switch (basename.slice(dot + 1).toLowerCase()) {
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    default:
      return null;
  }
}

function entryType(kind: ArtifactKind): ScanType {
  return kind === 'markdown' ? 'markdown' : 'html';
}

/** The entry first, then the others by path (plain code unit order, the same on every host). */
function compareForText(entryPath: string, a: string, b: string): number {
  if (a === b) return 0;
  if (a === entryPath) return -1;
  if (b === entryPath) return 1;
  return a < b ? -1 : 1;
}

/** Bytes read of a file: `SCAN_MAX_BYTES`, or less for Markdown. */
function readLimit(type: ScanType): number {
  return type === 'markdown' ? MARKDOWN_MAX_BYTES : SCAN_MAX_BYTES;
}

function decode(bytes: Buffer, max: number): string {
  return decoder.decode(bytes.length > max ? bytes.subarray(0, max) : bytes);
}

/** The first `max` UTF-16 units of `text`, not ending between the halves of a surrogate pair. */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** A title or heading: blanks collapsed, NFC, at most 200 characters (code points); null if empty. */
function cleanTitle(raw: string): string | null {
  const text = raw.replace(BLANKS, ' ').trim().normalize('NFC');
  if (text === '') return null;
  const characters = Array.from(text);
  return characters.length > TITLE_MAX_CHARS ? characters.slice(0, TITLE_MAX_CHARS).join('') : text;
}

function cleanThemeColor(raw: string): string | null {
  const value = raw.trim();
  return value.length <= THEME_COLOR_MAX_CHARS && THEME_COLOR.test(value) ? value : null;
}

/**
 * Collects page text for search: whitespace collapsed to single spaces, stopping at the cap.
 * Text is joined as given (no case folding: the search helpers fold it), but a word boundary
 * (`boundary()`) puts a space between pieces that would otherwise run together.
 */
class TextSink {
  private readonly parts: string[] = [];
  private length = 0;
  private spaceDue = false;

  constructor(private readonly max: number) {}

  get full(): boolean {
    return this.length >= this.max;
  }

  get text(): string {
    return this.parts.join('');
  }

  /** The next text starts a new word, even if it has no leading whitespace. */
  boundary(): void {
    this.spaceDue = true;
  }

  add(raw: string): void {
    if (this.full) return;
    const collapsed = raw.replace(BLANKS, ' ');
    const body = collapsed.trim();
    if (body === '') {
      if (collapsed !== '') this.spaceDue = true;
      return;
    }
    if (this.length > 0 && (this.spaceDue || collapsed.startsWith(' '))) this.push(' ');
    this.push(body);
    this.spaceDue = collapsed.endsWith(' ');
  }

  private push(piece: string): void {
    const room = this.max - this.length;
    if (piece.length > room) {
      this.parts.push(cutUnits(piece, room));
      this.length = this.max;
      return;
    }
    this.parts.push(piece);
    this.length += piece.length;
  }
}

/** Root-absolute URLs found so far: at most `MAX_WARNINGS`, each file and URL once. */
class WarningCollector {
  readonly list: PublishWarning[] = [];
  private readonly seen = new Set<string>();

  get full(): boolean {
    return this.list.length >= MAX_WARNINGS;
  }

  /** Warns when `url` starts with a single `/` (or `\`, which browsers read as `/`). */
  check(file: string, url: string): void {
    if (this.full) return;
    const value = url.replace(/^[\t\n\f\r ]+/, '');
    if (!/^[/\\](?![/\\])/.test(value)) return;
    const shown = quotePath(value.trimEnd(), WARNING_URL_MAX);
    const key = `${file}\0${shown}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({
      code: 'root_absolute_url',
      file,
      url: shown,
      message: t('publish.warning.rootAbsolute', { file: quotePath(file), url: quotePath(shown) }),
    });
  }
}

/** What only the entry page tells: its title, theme color and the images that may be its thumbnail. */
class EntryProbe {
  /** From `<title>` (HTML) or the first heading (Markdown). */
  title: string | null = null;
  /** The first non-empty HTML heading, used when there is no `<title>`. */
  heading: string | null = null;
  themeColor: string | null = null;
  themeColorSeen = false;
  readonly ogImages: string[] = [];
  readonly images: string[] = [];

  addOgImage(ref: string): void {
    if (this.ogImages.length < IMAGE_CANDIDATES) this.ogImages.push(ref);
  }

  addImage(ref: string): void {
    if (this.images.length < IMAGE_CANDIDATES) this.images.push(ref);
  }

  /** The first `og:image`, else the first image, that is a raster file of the version. */
  thumbnail(entryPath: string, byPath: ReadonlyMap<string, MetadataFile>): string | null {
    for (const ref of [...this.ogImages, ...this.images]) {
      const path = resolveRef(entryPath, ref);
      if (path === null) continue;
      const file = byPath.get(path);
      if (file !== undefined && isRasterImage(file.contentType)) return path;
    }
    return null;
  }
}

/**
 * Walks an HTML document once. `sink` gets its text, `warnings` its root-absolute URLs (in
 * attributes and `<style>` blocks) and `probe`, for the entry page, its title and thumbnail
 * candidates. Callbacks only: no tree, nothing executed or fetched.
 */
function scanHtml(
  source: string,
  file: string,
  sink: TextSink | null,
  warnings: WarningCollector | null,
  probe: EntryProbe | null,
): void {
  sink?.boundary();
  let depth = 0;
  /** Inside script, style or template: no text, no metadata. */
  let silent = 0;
  let svg = 0;
  let style: string | null = null;
  let title: string | null = null;
  let titleDone = false;
  let heading: { name: string; text: string } | null = null;

  const parser = new Parser({
    onopentag(name, attribs) {
      depth++;
      if (warnings !== null && !warnings.full) {
        for (const attribute in attribs) {
          const value = attribs[attribute];
          if (value === undefined || !URL_ATTRIBUTES.has(attribute)) continue;
          if (attribute === 'srcset') {
            for (const url of srcsetUrls(value)) {
              warnings.check(file, url);
              if (warnings.full) break;
            }
          } else {
            warnings.check(file, value);
          }
        }
      }
      if (SILENT_ELEMENTS.has(name)) silent++;
      else if (name === 'svg') svg++;
      if (name === 'style' && warnings !== null) style = '';
      if (silent > 0) return;

      if (!FORMATTING_ELEMENTS.has(name)) sink?.boundary();
      if (probe === null) return;
      if (name === 'title') {
        if (!titleDone && svg === 0) title = '';
      } else if (/^h[1-6]$/.test(name)) {
        if (probe.heading === null && heading === null) heading = { name, text: '' };
      } else if (name === 'meta') {
        const key = (attribs.name ?? '').toLowerCase();
        const content = attribs.content;
        if (content === undefined) return;
        if (key === 'theme-color' && !probe.themeColorSeen) {
          probe.themeColorSeen = true;
          probe.themeColor = cleanThemeColor(content);
        }
        if (key === 'og:image' || (attribs.property ?? '').toLowerCase() === 'og:image') {
          probe.addOgImage(content);
        }
      } else if (name === 'img' && attribs.src !== undefined) {
        probe.addImage(attribs.src);
      }
    },
    onclosetag(name) {
      depth--;
      if (name === 'style' && style !== null) {
        if (warnings !== null) scanStylesheet(style, file, warnings);
        style = null;
      }
      if (SILENT_ELEMENTS.has(name)) silent = Math.max(0, silent - 1);
      else if (name === 'svg') svg = Math.max(0, svg - 1);
      if (silent > 0) return;

      if (title !== null && name === 'title') {
        if (probe !== null) probe.title = cleanTitle(title);
        title = null;
        titleDone = true;
      }
      if (heading !== null && heading.name === name) {
        if (probe !== null) probe.heading = cleanTitle(heading.text);
        heading = null;
      }
      if (!FORMATTING_ELEMENTS.has(name)) sink?.boundary();
    },
    ontext(data) {
      if (style !== null) style += data;
      if (silent > 0) return;
      if (title !== null) title += cutUnits(data, TITLE_SCAN_CHARS - title.length);
      if (heading !== null) heading.text += cutUnits(data, TITLE_SCAN_CHARS - heading.text.length);
      sink?.add(data);
    },
  });

  const finished = () =>
    probe === null && (sink === null || sink.full) && (warnings === null || warnings.full);
  try {
    for (const chunk of chunks(source)) {
      parser.write(chunk);
      if (depth > HTML_MAX_DEPTH || finished()) break;
    }
    parser.end();
  } catch {
    // Malformed markup must not fail a publish: keep what was collected before the parser gave up.
  }
}

/** `source` in `HTML_CHUNK` pieces that never split a surrogate pair. */
function* chunks(source: string): Generator<string> {
  for (let start = 0; start < source.length; ) {
    let end = Math.min(start + HTML_CHUNK, source.length);
    const last = source.charCodeAt(end - 1);
    if (end < source.length && last >= 0xd800 && last <= 0xdbff) end++;
    yield source.slice(start, end);
    start = end;
  }
}

/**
 * Walks a Markdown document's tokens (it is parsed, never rendered, and raw HTML stays text).
 * `sink` gets text, inline code and code blocks; `probe`, for the entry page, gets the first
 * heading as its title and the images as thumbnail candidates.
 */
function scanMarkdown(source: string, sink: TextSink | null, probe: EntryProbe | null): void {
  sink?.boundary();
  let tokens: Token[];
  try {
    tokens = markdown.parse(source, {});
  } catch {
    // Same rule as for HTML: whatever the parser could not read adds nothing.
    return;
  }

  let afterHeading = false;
  for (const token of tokens) {
    if (token.type === 'inline') {
      const children = token.children ?? [];
      const text = inlineText(children);
      sink?.add(text);
      if (probe !== null) {
        if (afterHeading && probe.title === null) probe.title = cleanTitle(text);
        for (const child of children) {
          const src = child.type === 'image' ? child.attrGet('src') : null;
          if (typeof src === 'string') probe.addImage(src);
        }
      }
    } else {
      sink?.boundary();
      if (token.type === 'fence' || token.type === 'code_block') sink?.add(token.content);
    }
    afterHeading = token.type === 'heading_open';
  }
}

function inlineText(children: Token[]): string {
  let text = '';
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline') text += child.content;
    else if (child.type === 'softbreak' || child.type === 'hardbreak') text += ' ';
  }
  return text;
}

/** Reports every `url(...)` and `@import` of a stylesheet (or `<style>` block) to `warnings`. */
function scanStylesheet(css: string, file: string, warnings: WarningCollector): void {
  for (const url of cssUrls(css)) {
    warnings.check(file, url);
    if (warnings.full) return;
  }
}

/** The first `max` bytes of a stored file; null, with a log line, when its blob is missing. */
async function readHead(
  deps: AppDeps,
  versionId: string,
  row: { path: string; sha256: string; size: number },
  max: number,
): Promise<Buffer | null> {
  const end = Math.min(row.size, max) - 1;
  try {
    const stream = await deps.blobs.get(row.sha256, { start: 0, end });
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    return Buffer.concat(parts);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
    deps.logger.warn(
      { versionId, path: quotePath(row.path), sha256: row.sha256 },
      'A stored file has no blob, so its text is left out of the search index',
    );
    return null;
  }
}
