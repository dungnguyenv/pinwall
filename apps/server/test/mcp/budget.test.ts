import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type Anchor, QUOTE_CONTEXT_CHARS } from '@pinwall/shared/protocol';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { filesAt, readText } from '../../src/domain/version-files.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { callText, connectMcp } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { postThread } from '../helpers/review.ts';

/**
 * The budget test of the agent tools (spec §9). One scenario, run on a page the size of a real
 * one: a reviewer pinned 5 comments on a 90 KB single-page table, and the agent answers them in
 * 3 calls. Whatever the page weighs, no call may send or return more than `BUDGET` characters
 * (the JavaScript length of the text). A failure here is a bug in the tools, not in this test.
 */

const T = Date.UTC(2026, 10, 18);
const BUDGET = 4_000;
const ROWS = 600;
const SNIPPET_CHARS = 160;

// ---------------------------------------------------------------------------------------------
// The page. Every row is on one line of the source, and the table has no `<tbody>`: the browser
// puts the rows in one, so the annotator writes `#plan > tbody > tr:nth-of-type(k)`.
// ---------------------------------------------------------------------------------------------

const DISTRICTS = ['Quận 1', 'Quận 3', 'Bình Thạnh', 'Phú Nhuận', 'Thủ Đức', 'Quận 7'];
const VIEWS = [
  'view sông Sài Gòn',
  'view công viên',
  'hướng Đông Nam',
  'ban công rộng',
  'gần trường học',
];
const STATUSES = ['Còn trống', 'Đã cọc', 'Thương lượng', 'Đã bán'];
/** Every 20th row carries a long note, so a few lines are longer than a snippet line. */
const NOTE = ', chủ nhà thiện chí, xem nhà cuối tuần phải hẹn trước';

const code = (i: number) => `CH-${String(i).padStart(4, '0')}`;
const floor = (i: number) => 3 + (i % 25);
const status = (i: number) => STATUSES[i % STATUSES.length] ?? '';
/** 2.000 to 4.999 million dong, one price for each row of the table (37 and 3000 share no factor). */
function price(i: number): string {
  const million = String(2000 + ((i * 37) % 3000));
  return `${million.slice(0, 1)}.${million.slice(1)}.000.000 ₫`;
}
const hasNote = (i: number) => i % 20 === 15;
const descriptionOf = (i: number) =>
  `Căn hộ ${1 + (i % 3)}PN, ${DISTRICTS[i % DISTRICTS.length]}, tầng ${floor(i)}, ` +
  `${VIEWS[i % VIEWS.length]}${hasNote(i) ? NOTE : ''} (${code(i)})`;
const rowOf = (i: number) =>
  `<tr><td>${code(i)}</td><td>${descriptionOf(i)}</td><td>${price(i)}</td><td>${status(i)}</td></tr>`;

/** A page's source and the text a browser shows of its body, with HTML whitespace collapsed. */
interface Page {
  html: string;
  /** The source's lines, as `read_file` and `list_comments` count them (the first is line 1). */
  lines: string[];
  /** The page's body text: every text node, whitespace runs as one space. */
  text: string;
}

function buildPage(o: { script: boolean }): Page {
  const body = [
    '<h1>Bảng giá căn hộ quý 4</h1>',
    '<p>Cập nhật hằng tuần. Giá chưa gồm phí bảo trì.</p>',
    '<table id="plan">',
    '<thead><tr><th>Mã</th><th>Mô tả</th><th>Giá</th><th>Tình trạng</th></tr></thead>',
    ...Array.from({ length: ROWS }, (_, k) => rowOf(k + 1)),
    '</table>',
    ...(o.script ? ['<script src="app.js"></script>'] : []),
  ];
  const head = [
    '<!doctype html>',
    '<html lang="vi">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Bảng giá căn hộ</title>',
    '</head>',
    '<body>',
  ];
  const lines = [...head, ...body, '</body>', '</html>'];
  const text = body
    .map((line) => line.replace(/<[^>]*>/g, ''))
    .filter((line) => line !== '')
    .join(' ');
  return { html: `${lines.join('\n')}\n`, lines, text };
}

/** The line of the source (from 1) where row `i` is. */
const lineOfRow = (page: Page, i: number): number => page.lines.indexOf(rowOf(i)) + 1;

/** How many times `part` occurs in `whole`. */
const occurrences = (whole: string, part: string): number => whole.split(part).length - 1;

// ---------------------------------------------------------------------------------------------
// The five comments, as the annotator in the browser records them, and the fix each one asks for.
// ---------------------------------------------------------------------------------------------

/** The cell `td:nth-of-type(n)` of row `i`, as `cssPath` writes it. */
const cellPath = (i: number, n: number) =>
  `#plan > tbody > tr:nth-of-type(${i}) > td:nth-of-type(${n})`;

interface TextPick {
  row: number;
  /** The cell the selection is in. */
  cell: number;
  exact: string;
  /** The reviewer's comment. */
  body: string;
  /** What the agent changes in the source. */
  edit: { old_string: string; new_string: string };
  reply: string;
}

/**
 * The rows the reviewer commented on: two spots of the table, 20 rows apart. Rows 55 and 75
 * carry the long note, so their lines are longer than a snippet line.
 *
 * The merge diff of a refusal holds 4,000 characters, three lines of context either side. On
 * this page (lines of about 135 characters) it fits two groups of edits like these, 3,600
 * characters in all; four edits apart from each other make four hunks of about 1,100 characters
 * and are named "diff not shown: use read_file" instead.
 */
const ROW = { t1: 48, t2: 50, t3: 55, element: 75 } as const;

const T1: TextPick = {
  row: ROW.t1,
  cell: 2,
  exact: `tầng ${floor(ROW.t1)}, ${VIEWS[ROW.t1 % VIEWS.length]} (${code(ROW.t1)})`,
  body: 'Căn này ở tầng 16 chứ không phải tầng 26, anh sửa giúp mình.',
  edit: {
    old_string: `tầng ${floor(ROW.t1)}, ${VIEWS[ROW.t1 % VIEWS.length]} (${code(ROW.t1)})`,
    new_string: `tầng 16, ${VIEWS[ROW.t1 % VIEWS.length]} (${code(ROW.t1)})`,
  },
  reply: 'Đã sửa thành tầng 16.',
};
const T2: TextPick = {
  row: ROW.t2,
  cell: 3,
  exact: price(ROW.t2),
  body: 'Giá này cao hơn bảng giá của chủ đầu tư, đề nghị 3.790.000.000 ₫.',
  edit: { old_string: `<td>${price(ROW.t2)}</td>`, new_string: '<td>3.790.000.000 ₫</td>' },
  reply: 'Đã đổi giá sang 3.790.000.000 ₫.',
};
const T3: TextPick = {
  row: ROW.t3,
  cell: 2,
  exact: `xem nhà cuối tuần phải hẹn trước (${code(ROW.t3)})`,
  body: 'Ghi rõ là hẹn trước một ngày giúp mình nhé.',
  edit: {
    old_string: `phải hẹn trước (${code(ROW.t3)})`,
    new_string: `phải hẹn trước một ngày (${code(ROW.t3)})`,
  },
  reply: 'Đã thêm "một ngày".',
};
const ELEMENT = {
  row: ROW.element,
  body: 'Dòng này còn trống, không phải đã bán. Sửa lại tình trạng giúp mình.',
  edit: {
    old_string: `${price(ROW.element)}</td><td>${status(ROW.element)}</td>`,
    new_string: `${price(ROW.element)}</td><td>Còn trống</td>`,
  },
  reply: 'Đã đổi tình trạng thành "Còn trống".',
};
const POINT = {
  body: 'Bảng dài quá, thêm bộ lọc theo quận nhé?',
  reply: 'Chưa làm: đã ghi vào danh sách việc cần làm.',
};

/** The four edits of the loop, as `edit_artifact` takes them. */
const FOUR_REPLACES = [T1.edit, T2.edit, T3.edit, ELEMENT.edit].map((edit) => ({
  op: 'replace' as const,
  path: 'index.html',
  ...edit,
}));

/** What the annotator records for a selection of `exact` in cell `pick.cell` of row `pick.row`. */
function textAnchor(page: Page, pick: TextPick): Anchor {
  const start = page.text.indexOf(pick.exact);
  const end = start + pick.exact.length;
  if (start < 0 || page.text.indexOf(pick.exact, start + 1) >= 0) {
    throw new Error(`"${pick.exact}" is not once in the page text`);
  }
  return {
    page: '',
    kind: 'text',
    quote: {
      exact: pick.exact,
      prefix: page.text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start),
      suffix: page.text.slice(end, end + QUOTE_CONTEXT_CHARS),
    },
    dom: { path: cellPath(pick.row, pick.cell) },
    position: { x: 0.2, y: lineOfRow(page, pick.row) / page.lines.length },
    viewport: { width: 1280 },
  };
}

const elementAnchor = (page: Page): Anchor => ({
  page: '',
  kind: 'element',
  dom: { path: `#plan > tbody > tr:nth-of-type(${ELEMENT.row})` },
  position: { x: 0.5, y: lineOfRow(page, ELEMENT.row) / page.lines.length },
  viewport: { width: 1280 },
});

const pointAnchor = (): Anchor => ({
  page: '',
  kind: 'point',
  position: { x: 0.4, y: 0.5 },
  viewport: { width: 1280 },
});

/** The snippet line the server shows for a source `line` that a location starts in at `column`. */
function snippetLine(line: string, column: number): string {
  const shown = line.length <= SNIPPET_CHARS || column === 0 ? line : `…${line.slice(column)}`;
  return shown.length <= SNIPPET_CHARS ? shown : `${shown.slice(0, SNIPPET_CHARS - 1)}…`;
}

/** The lines of the thread `id` in a `list_comments` text: its header, then up to the next one. */
function blockOf(text: string, id: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith(`[${id}]`));
  if (at < 0) throw new Error(`thread ${id} is not in the text`);
  const rest = lines.slice(at + 1);
  const next = rest.findIndex((line) => line.startsWith('[cmt_'));
  return [lines[at] ?? '', ...(next < 0 ? rest : rest.slice(0, next))];
}

describe.each(dialects)('the review loop budget on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let bob: { user: UserRow; cookie: string };
  let client: Client;
  const plain = buildPage({ script: false });
  const scripted = buildPage({ script: true });

  /** An artifact of the page, v1, with the 5 open threads Bob pinned on it. */
  interface Scenario {
    id: string;
    v1: VersionRow;
    threads: { t1: string; t2: string; t3: string; element: string; point: string };
  }

  async function scenario(page: Page): Promise<Scenario> {
    const first = await publishFiles(ctx, ada.user, { 'index.html': page.html });
    const { id } = first.artifact;
    // One second apart, so that `list_comments` lists them in the order they were pinned.
    const pin = async (anchor: Anchor, body: string) => {
      clock.advance(1000);
      return (await postThread(ctx, bob.cookie, id, { anchor, body })).id;
    };
    return {
      id,
      v1: first.version,
      threads: {
        t1: await pin(textAnchor(page, T1), T1.body),
        t2: await pin(textAnchor(page, T2), T2.body),
        t3: await pin(textAnchor(page, T3), T3.body),
        element: await pin(elementAnchor(page), ELEMENT.body),
        point: await pin(pointAnchor(), POINT.body),
      },
    };
  }

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    bob = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bob' });
    client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
  });
  afterEach(async () => {
    await client.close();
    await ctx.close();
  });

  /** The text of `path` in `version`. */
  async function sourceOf(versionId: string, path = 'index.html'): Promise<string> {
    const version = await ctx.deps.db.db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow();
    const file = (await filesAt(ctx.deps, version, [path])).get(path);
    if (file === undefined) throw new Error(`${versionId} has no ${path}`);
    return readText(ctx.deps, file);
  }

  /** Every call the agent makes, as it was sent and as it was answered. */
  interface Call {
    name: string;
    input: string;
    output: string;
  }

  /** The agent's loop: read the comments, make the four edits, resolve the five threads. */
  async function runLoop(s: Scenario) {
    const calls: Call[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await callText(client, name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      calls.push({ name, input: JSON.stringify(args), output: r.text });
      return r;
    };
    const listed = await call('list_comments', { artifact_id: s.id });
    const edited = await call('edit_artifact', {
      artifact_id: s.id,
      expected_version_id: s.v1.id,
      edits: FOUR_REPLACES,
    });
    const versionId = /version_id (ver_\w+)/.exec(edited.text)?.[1] ?? '';
    const resolved = await call('resolve_comments', {
      version_id: versionId,
      threads: [
        { comment_id: s.threads.t1, reply: T1.reply },
        { comment_id: s.threads.t2, reply: T2.reply },
        { comment_id: s.threads.t3, reply: T3.reply },
        { comment_id: s.threads.element, reply: ELEMENT.reply },
        { comment_id: s.threads.point, reply: POINT.reply },
      ],
    });
    return { calls, listed, edited, resolved, versionId };
  }

  test('the page is the 90 KB table of the scenario', () => {
    expect(Buffer.byteLength(plain.html)).toBeGreaterThanOrEqual(90_000);
    expect(Buffer.byteLength(plain.html)).toBeLessThan(93_000);
    expect(plain.html.match(/<tr><td>/g)).toHaveLength(ROWS);
    expect(plain.html).not.toContain('<tbody');
    // Vietnamese, so a character is not a byte.
    expect(Buffer.byteLength(plain.html)).toBeGreaterThan(plain.html.length + 4_000);
    // Each edit and each quote names one place of the page.
    for (const { old_string } of FOUR_REPLACES) expect(occurrences(plain.html, old_string)).toBe(1);
    for (const pick of [T1, T2, T3]) expect(occurrences(plain.html, pick.exact)).toBe(1);
    // The rows of T3 and of the element are longer than a snippet line, the others are not.
    expect(rowOf(T3.row).length).toBeGreaterThan(SNIPPET_CHARS);
    expect(rowOf(ELEMENT.row).length).toBeGreaterThan(SNIPPET_CHARS);
    expect(rowOf(T1.row).length).toBeLessThanOrEqual(SNIPPET_CHARS);
    expect(rowOf(T2.row).length).toBeLessThanOrEqual(SNIPPET_CHARS);
  });

  test('the review loop takes 3 calls, none over 4,000 characters', async () => {
    const s = await scenario(plain);
    const { calls, listed, edited, resolved, versionId } = await runLoop(s);

    expect(calls.map((c) => c.name)).toEqual([
      'list_comments',
      'edit_artifact',
      'resolve_comments',
    ]);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.input.length, `${c.name} input`).toBeLessThanOrEqual(BUDGET);
      expect(c.output.length, `${c.name} output`).toBeLessThanOrEqual(BUDGET);
    }

    // The agent saw where each comment sits without reading the page: the 4 located threads say
    // so, the point does not.
    expect(listed.text.match(/^ {2}source: index\.html:\d+/gm)).toHaveLength(4);
    expect(listed.text).toContain(t('mcp.comments.untrusted'));

    // The loop did the work it is billed for.
    expect(edited.text).toMatch(/^Review link: /);
    expect(edited.text).toMatch(/^Published v2 \(version_id ver_\w+, artifact_id art_\w+\)\.$/m);
    expect(edited.text).toMatch(/^index\.html: 4 replacements, now lines \d+–\d+$/m);
    expect(resolved.text.split('\n')[0]).toBe(t('mcp.resolve.summary', { ok: 5, total: 5 }));
    expect(versionId).toMatch(/^ver_/);
    let expected = plain.html;
    for (const { old_string, new_string } of FOUR_REPLACES) {
      expected = expected.split(old_string).join(new_string);
    }
    expect(expected).not.toBe(plain.html);
    expect(await sourceOf(versionId)).toBe(expected);
    const open = await ctx.deps.db.db
      .selectFrom('comments')
      .select('id')
      .where('artifact_id', '=', s.id)
      .where('parent_id', 'is', null)
      .where('status', '=', 'open')
      .execute();
    expect(open).toEqual([]);
  });

  test('the located threads name the right lines, and the point none', async () => {
    const s = await scenario(plain);
    const { text } = await callText(client, 'list_comments', { artifact_id: s.id });
    const entry = t('mcp.comment.entryPage');
    const header = (id: string, where: string) => `[${id}] v1 · ${entry}: ${where}`;
    const textWhere = (pick: TextPick) => {
      const { quote, dom } = textAnchor(plain, pick);
      return `text "${quote?.exact}" (after "${quote?.prefix}", before "${quote?.suffix}") in ${dom?.path}`;
    };

    const expectThread = (
      id: string,
      pick: TextPick | null,
      row: number,
      column: number,
      comment: string,
    ) => {
      const line = lineOfRow(plain, row);
      expect(line).toBeGreaterThan(0);
      expect(blockOf(text, id)).toEqual([
        header(
          id,
          pick === null ? `element #plan > tbody > tr:nth-of-type(${row})` : textWhere(pick),
        ),
        `  source: index.html:${line} in v1 (current)`,
        `    ${line}| ${snippetLine(rowOf(row), column)}`,
        `  Bob: ${comment}`,
      ]);
    };
    expectThread(s.threads.t1, T1, T1.row, rowOf(T1.row).indexOf(T1.exact), T1.body);
    expectThread(s.threads.t2, T2, T2.row, rowOf(T2.row).indexOf(T2.exact), T2.body);
    expectThread(s.threads.t3, T3, T3.row, rowOf(T3.row).indexOf(T3.exact), T3.body);
    expectThread(s.threads.element, null, ELEMENT.row, 0, ELEMENT.body);

    // The long row of the element is cut, and the long row of T3 is shown from its quote.
    expect(snippetLine(rowOf(ELEMENT.row), 0)).toHaveLength(SNIPPET_CHARS);
    expect(snippetLine(rowOf(ELEMENT.row), 0).endsWith('…')).toBe(true);
    expect(snippetLine(rowOf(T3.row), rowOf(T3.row).indexOf(T3.exact)).startsWith('…xem nhà')).toBe(
      true,
    );

    expect(blockOf(text, s.threads.point)).toEqual([
      header(s.threads.point, t('mcp.comment.point', { x: 40, y: 50 })),
      `  Bob: ${POINT.body}`,
    ]);
    expect(text.match(/^\[cmt_/gm)).toHaveLength(5);
  });

  test('the scripted copy marks its element location unverified only', async () => {
    const s = await scenario(scripted);
    const { text } = await callText(client, 'list_comments', { artifact_id: s.id });
    const lineOf = (row: number) => lineOfRow(scripted, row);

    // The script is the last line of the body: no row moved.
    for (const row of [T1.row, T2.row, T3.row, ELEMENT.row]) {
      expect(lineOf(row)).toBe(lineOfRow(plain, row));
    }
    expect(blockOf(text, s.threads.element).slice(1, 3)).toEqual([
      `  source (unverified: the page runs scripts): index.html:${lineOf(ELEMENT.row)} in v1 (current)`,
      `    ${lineOf(ELEMENT.row)}| ${snippetLine(rowOf(ELEMENT.row), 0)}`,
    ]);
    for (const [id, pick] of [
      [s.threads.t1, T1],
      [s.threads.t2, T2],
      [s.threads.t3, T3],
    ] as const) {
      expect(blockOf(text, id)[1], pick.exact).toBe(
        `  source: index.html:${lineOf(pick.row)} in v1 (current)`,
      );
    }
    expect(blockOf(text, s.threads.point).filter((line) => line.includes('source'))).toEqual([]);
    expect(text.match(/^ {2}source \(unverified/gm)).toHaveLength(1);
    expect(text.match(/^ {2}source: index\.html:\d+/gm)).toHaveLength(3);
    expect(text.length).toBeLessThanOrEqual(BUDGET);
  });

  test('a stale full publish after the loop is refused with the diff, and passes with replace_server_edits', async () => {
    const s = await scenario(plain);
    const { versionId } = await runLoop(s);
    const stale = {
      artifact_id: s.id,
      expected_version_id: versionId,
      files: [{ path: 'index.html', content: plain.html }],
    };
    // What the same fix costs without edit_artifact: the whole page, sent back. Vietnamese takes
    // more than one byte a character, so 90 KB of it is a little over 80,000 characters.
    expect(JSON.stringify(stale).length).toBeGreaterThan(20 * BUDGET);

    const refused = await callText(client, 'publish_inline', stale);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"reason":"edited_on_server"');
    expect(refused.text).toContain('"paths":["index.html"]');
    expect(refused.text).toContain(t('mcp.hint.conflict.edited_on_server'));

    // The diff is the part after its heading: the lines the 4 edits changed, old and new.
    const diff = refused.text.split(t('mcp.merge.heading'))[1] ?? '';
    expect(diff, refused.text).toContain('--- index.html\tv1');
    expect(diff).toContain('+++ index.html\tv2');
    for (const row of [T1.row, T2.row, T3.row, ELEMENT.row]) {
      const was = rowOf(row);
      const now = FOUR_REPLACES.reduce(
        (line, { old_string, new_string }) => line.split(old_string).join(new_string),
        was,
      );
      expect(now, `row ${row}`).not.toBe(was);
      expect(diff).toContain(`-${was}\n`);
      expect(diff).toContain(`+${now}`);
    }
    expect(
      await ctx.deps.db.db
        .selectFrom('versions')
        .select('id')
        .where('artifact_id', '=', s.id)
        .execute(),
    ).toHaveLength(2);

    const replaced = await callText(client, 'publish_inline', {
      ...stale,
      replace_server_edits: true,
    });
    expect(replaced.isError, replaced.text).toBe(false);
    const v3 = /version_id (ver_\w+)/.exec(replaced.text)?.[1] ?? '';
    expect(await sourceOf(v3)).toBe(plain.html);

    // A full publish on top of a full publish is not checked.
    const third = await callText(client, 'publish_inline', {
      artifact_id: s.id,
      expected_version_id: v3,
      files: [{ path: 'index.html', content: plain.html.replace('hằng tuần', 'hằng ngày') }],
    });
    expect(third.isError, third.text).toBe(false);
  });
});
