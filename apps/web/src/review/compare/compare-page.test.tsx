import type { ViewerToPageMessage } from '@pinwall/shared/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { FileChange, MarkdownDiff, TextFileDiff } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { simFrame } from '../../test/annotator-sim.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import { grantUrl, reviewer, serveReview } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';
import { CONTENT_SANDBOX } from '../frame/sandbox.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const TIMEOUT = { timeout: 5000 };

const frameOf = async (n: number) =>
  (await screen.findByTitle(`Pricing, v${n}`, {}, TIMEOUT)) as HTMLIFrameElement;
const scrollsTo = (m: ViewerToPageMessage[]) => m.filter((msg) => msg.type === 'scroll-to');

/** A changed file of the given status; `type` is its content type on both sides. */
function change(path: string, status: FileChange['status'] = 'modified', type = 'text/plain') {
  const side = { sha256: `sha-${path}`, size: 120, content_type: type };
  return {
    path,
    status,
    old: status === 'added' ? null : side,
    new: status === 'removed' ? null : side,
  } satisfies FileChange;
}

/**
 * The review server of `art_1` (see `serveReview`) plus its diffs: `files` is
 * what every pair lists, `texts` and `markdown` the per-path file diffs.
 */
function serveCompare(
  o: {
    versions?: number[];
    kind?: 'html' | 'markdown';
    files?: FileChange[];
    texts?: Record<string, Partial<TextFileDiff>>;
    markdown?: Record<string, Partial<MarkdownDiff>>;
  } = {},
) {
  const s = serveReview({ versions: o.versions });
  if (o.kind) s.artifact = { ...s.artifact, kind: o.kind };
  const diff = { files: o.files ?? [] };
  const query = (request: Request) => new URL(request.url).searchParams;
  server.use(
    http.get(`${API}/artifacts/art_1/diff`, ({ request }) => {
      const q = query(request);
      return HttpResponse.json({
        from: Number(q.get('from')),
        to: Number(q.get('to')),
        files: diff.files,
      });
    }),
    http.get(`${API}/artifacts/art_1/diff/file`, ({ request }) => {
      const path = query(request).get('path') ?? '';
      return HttpResponse.json({
        path,
        binary: false,
        too_large: false,
        patch: null,
        old: null,
        new: null,
        ...o.texts?.[path],
      });
    }),
    http.get(`${API}/artifacts/art_1/diff/markdown`, ({ request }) => {
      const path = query(request).get('path') ?? '';
      return HttpResponse.json({ path, too_large: false, blocks: [], ...o.markdown?.[path] });
    }),
  );
  return { ...s, diff };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test('defaults to the previous version against the current one', async () => {
  const s = serveCompare();
  const { router } = renderRoute('/a/art_1/compare', { me: reviewer });

  await waitFor(() => expect(router.state.location.search).toBe('?from=2&to=3&view=side'), TIMEOUT);
  expect(router.state.historyAction).toBe('REPLACE');
  const left = await frameOf(2);
  const right = await frameOf(3);
  expect(left).toHaveAttribute('src', grantUrl(2));
  expect(right).toHaveAttribute('src', grantUrl(3));
  for (const frame of [left, right]) {
    expect(frame.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
  }
  expect(document.querySelectorAll('iframe')).toHaveLength(2);
  expect(s.requests).toContain('GET /api/v1/artifacts/art_1/versions/2/preview?mode=review');
  expect(s.requests).toContain('GET /api/v1/artifacts/art_1/versions/3/preview?mode=review');

  // Each frame is labelled with its version, From on the left.
  expect(within(screen.getByRole('region', { name: 'v2' })).getByTitle('Pricing, v2')).toBe(left);
  expect(within(screen.getByRole('region', { name: 'v3' })).getByTitle('Pricing, v3')).toBe(right);
  expect(screen.getByRole('link', { name: 'Back to Pricing' })).toHaveAttribute('href', '/a/art_1');
  expect(screen.getByRole('combobox', { name: 'From' })).toHaveTextContent('v2');
  expect(screen.getByRole('combobox', { name: 'To' })).toHaveTextContent('v3');
  expect(screen.getByRole('radio', { name: 'Side by side' })).toBeChecked();
  expect(screen.queryByRole('radio', { name: 'Rendered' })).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Sync scrolling' })).toBeChecked();
  expect(document.title).toBe('Compare “Pricing” · Pinwall');
});

test('the address keeps the versions that exist', async () => {
  serveCompare();
  // The review screen's Compare link names only `to`, the version it shows.
  const { router } = renderRoute('/a/art_1/compare?to=1', { me: reviewer });
  await waitFor(() => expect(router.state.location.search).toBe('?from=2&to=1&view=side'), TIMEOUT);
  await frameOf(1);

  await act(() => router.navigate('/a/art_1/compare?from=3&to=9&view=nope'));
  // `to` 9 does not exist: it falls back to the current version, 3, and from moves below it.
  await waitFor(() => expect(router.state.location.search).toBe('?from=2&to=3&view=side'), TIMEOUT);
});

test('a version on a later page of the list is read before the pair is chosen', async () => {
  const s = serveCompare();
  server.use(
    http.get(`${API}/artifacts/art_1/versions`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      return HttpResponse.json(
        cursor === null ? fx.page(s.versions.slice(0, 2), 'page-2') : fx.page(s.versions.slice(2)),
      );
    }),
  );
  const { router } = renderRoute('/a/art_1/compare?from=1&to=3', { me: reviewer });
  await waitFor(() => expect(router.state.location.search).toBe('?from=1&to=3&view=side'), TIMEOUT);
  await frameOf(1);
  expect(s.requests).toContain('GET /api/v1/artifacts/art_1/versions?limit=50&cursor=page-2');
});

test('side by side mirrors scrolling from the frame under the pointer', async () => {
  serveCompare();
  const { user } = renderRoute('/a/art_1/compare?from=2&to=3&view=side', { me: reviewer });
  const left = simFrame((await frameOf(2)).contentWindow as Window);
  const right = simFrame((await frameOf(3)).contentWindow as Window);
  left.ready();
  right.ready();

  fireEvent.pointerEnter(screen.getByRole('region', { name: 'v2' }));
  left.scrolled(0, 0.5);
  expect(scrollsTo(right.received())).toEqual([{ pinwall: 1, type: 'scroll-to', x: 0, y: 0.5 }]);
  // The follower's own scroll, echoing the mirror, goes nowhere.
  right.scrolled(0, 0.5);
  expect(scrollsTo(left.received())).toEqual([]);

  // Focus leads too: the right frame now drives the left.
  fireEvent.focusIn(screen.getByRole('region', { name: 'v3' }));
  right.scrolled(0.1, 0.2);
  expect(scrollsTo(left.received())).toEqual([{ pinwall: 1, type: 'scroll-to', x: 0.1, y: 0.2 }]);

  await user.click(screen.getByRole('switch', { name: 'Sync scrolling' }));
  expect(screen.getByRole('switch', { name: 'Sync scrolling' })).not.toBeChecked();
  right.scrolled(0, 0.9);
  fireEvent.pointerEnter(screen.getByRole('region', { name: 'v2' }));
  left.scrolled(0, 0.7);
  expect(scrollsTo(left.received())).toHaveLength(1);
  expect(scrollsTo(right.received())).toHaveLength(1);
});

test('the overlay slider moves with keyboard and pointer', async () => {
  serveCompare();
  const { user } = renderRoute('/a/art_1/compare?from=2&to=3&view=overlay', { me: reviewer });
  const top = (await frameOf(3)).closest<HTMLElement>('[data-overlay-top]');
  // jsdom writes the zero lengths as 0px.
  const clip = () => top?.style.clipPath.replaceAll('0px', '0');
  await frameOf(2);
  const slider = screen.getByRole('slider', { name: 'Divider between v2 and v3' });
  expect(slider).toHaveAttribute('aria-valuemin', '0');
  expect(slider).toHaveAttribute('aria-valuemax', '100');
  expect(slider).toHaveAttribute('aria-valuenow', '50');
  expect(clip()).toBe('inset(0 0 0 50%)');
  // No Sync switch: the overlay always scrolls both.
  expect(screen.queryByRole('switch', { name: 'Sync scrolling' })).not.toBeInTheDocument();

  slider.focus();
  await user.keyboard('{ArrowRight}');
  expect(slider).toHaveAttribute('aria-valuenow', '51');
  await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
  expect(slider).toHaveAttribute('aria-valuenow', '61');
  expect(clip()).toBe('inset(0 0 0 61%)');
  await user.keyboard('{ArrowLeft}');
  expect(slider).toHaveAttribute('aria-valuenow', '60');
  await user.keyboard('{End}');
  expect(slider).toHaveAttribute('aria-valuenow', '100');
  await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
  expect(slider).toHaveAttribute('aria-valuenow', '100');
  await user.keyboard('{Home}');
  expect(slider).toHaveAttribute('aria-valuenow', '0');

  // Dragging: the box spans x 100..1100; a shield keeps the frames from taking the pointer.
  const box = slider.closest<HTMLElement>('[data-overlay]');
  if (box === null) throw new Error('No overlay box');
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 0, width: 1000, height: 600 }),
  );
  const capture = vi.spyOn(slider, 'setPointerCapture');
  expect(document.querySelector('[data-drag-shield]')).toBeNull();
  fireEvent.pointerDown(slider, { pointerId: 7, clientX: 350, button: 0 });
  expect(capture).toHaveBeenCalledWith(7);
  expect(slider).toHaveAttribute('aria-valuenow', '25');
  expect(document.querySelector('[data-drag-shield]')).not.toBeNull();
  fireEvent.pointerMove(slider, { pointerId: 7, clientX: 1500 });
  expect(slider).toHaveAttribute('aria-valuenow', '100');
  fireEvent.pointerMove(slider, { pointerId: 7, clientX: 803 });
  expect(slider).toHaveAttribute('aria-valuenow', '70.3');
  expect(clip()).toBe('inset(0 0 0 70.3%)');
  fireEvent.pointerUp(slider, { pointerId: 7, clientX: 803 });
  expect(document.querySelector('[data-drag-shield]')).toBeNull();
  // Moving without a drag does nothing.
  fireEvent.pointerMove(slider, { pointerId: 7, clientX: 200 });
  expect(slider).toHaveAttribute('aria-valuenow', '70.3');
});

test('the overlay scrolls both frames and says when it cannot', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    serveCompare();
    renderRoute('/a/art_1/compare?from=2&to=3&view=overlay', { me: reviewer });
    const fromFrame = await frameOf(2);
    const toFrame = await frameOf(3);
    const from = simFrame(fromFrame.contentWindow as Window);
    const to = simFrame(toFrame.contentWindow as Window);
    from.ready();
    to.ready();
    fireEvent.pointerEnter(fromFrame.closest('[data-overlay-from]') as HTMLElement);
    from.scrolled(0, 0.25);
    expect(scrollsTo(to.received())).toEqual([{ pinwall: 1, type: 'scroll-to', x: 0, y: 0.25 }]);
    expect(screen.queryByText(t('web.compare.noSync'))).not.toBeInTheDocument();

    // The first load answers the ready above; the next document says nothing within 3 s.
    fireEvent.load(toFrame);
    fireEvent.load(toFrame);
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(await screen.findByText(t('web.compare.noSync'), {}, TIMEOUT)).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('files: list, unified diff, binary and large files', async () => {
  const s = serveCompare({
    files: [change('b'), change('c.png', 'modified', 'image/png'), change('d.txt', 'added')],
    texts: {
      b: { patch: 'Index: b\n===\n--- b\tv2\n+++ b\tv3\n@@ -1,3 +1,3 @@\n a\n-2\n+22\n c\n' },
      'c.png': { binary: true },
      'd.txt': { too_large: true },
    },
  });
  const { user, router } = renderRoute('/a/art_1/compare?from=2&to=3&view=files', {
    me: reviewer,
  });

  const list = await screen.findByRole('list', { name: 'Changed files' }, TIMEOUT);
  expect(s.requests).toContain('GET /api/v1/artifacts/art_1/diff?from=2&to=3');
  const items = within(list).getAllByRole('button');
  expect(items.map((b) => b.textContent)).toEqual(['bChanged', 'c.pngChanged', 'd.txtAdded']);
  expect(items[0]).toHaveAttribute('aria-current', 'true');
  expect(screen.getByText(t('web.compare.fileCount', { count: 3 }))).toBeInTheDocument();
  // No Markdown changed in an HTML artifact: no rendered view.
  expect(screen.queryByRole('radio', { name: 'Rendered' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Sync scrolling' })).not.toBeInTheDocument();

  const plus = await screen.findByText('22', {}, TIMEOUT);
  expect(s.requests).toContain('GET /api/v1/artifacts/art_1/diff/file?from=2&to=3&path=b');
  const added = plus.closest('[data-kind]');
  expect(added).toHaveAttribute('data-kind', 'add');
  expect(added).toHaveTextContent(/^2\+22$/);
  expect(plus.tagName).toBe('MARK');
  const removed = document.querySelector('[data-kind="del"]');
  expect(removed).toHaveTextContent(/^2−2$/);
  expect(removed?.querySelector('mark')).toHaveTextContent(/^2$/);
  expect(document.querySelectorAll('[data-kind="context"]')).toHaveLength(2);
  expect(screen.getByText('@@ -1,3 +1,3 @@')).toBeInTheDocument();

  await user.click(within(list).getByRole('button', { name: /c\.png/ }));
  expect(within(list).getByRole('button', { name: /c\.png/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(await screen.findByText(t('web.compare.binary'), {}, TIMEOUT)).toBeInTheDocument();
  await user.click(within(list).getByRole('button', { name: /d\.txt/ }));
  expect(await screen.findByText(t('web.compare.tooLarge'), {}, TIMEOUT)).toBeInTheDocument();

  s.diff.files = [];
  await act(() => router.navigate('/a/art_1/compare?from=1&to=3&view=files'));
  expect(await screen.findByText(t('web.compare.noChanges'), {}, TIMEOUT)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Changed files' })).not.toBeInTheDocument();
});

test('a file list that fails to load offers Retry', async () => {
  serveCompare({ files: [change('b')], texts: { b: { patch: '@@ -1 +1 @@\n-x\n+y\n' } } });
  let failing = true;
  server.use(
    http.get(`${API}/artifacts/art_1/diff`, ({ request }) => {
      if (failing) return apiError(500, 'internal', 'The diff service is down.');
      const q = new URL(request.url).searchParams;
      return HttpResponse.json({
        from: Number(q.get('from')),
        to: Number(q.get('to')),
        files: [change('b')],
      });
    }),
  );
  const { user } = renderRoute('/a/art_1/compare?from=2&to=3&view=files', { me: reviewer });
  expect(await screen.findByText('The diff service is down.', {}, TIMEOUT)).toBeInTheDocument();
  failing = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('list', { name: 'Changed files' }, TIMEOUT)).toBeInTheDocument();
});

test('on a phone the file list is a select', async () => {
  setViewport(360);
  serveCompare({
    files: [change('a.css'), change('b.css', 'removed')],
    texts: {
      'a.css': { patch: '@@ -1 +1 @@\n-x\n+y\n' },
      'b.css': { patch: '@@ -1 +0,0 @@\n-gone\n' },
    },
  });
  const { user } = renderRoute('/a/art_1/compare?from=2&to=3&view=files', { me: reviewer });
  const select = await screen.findByRole('combobox', { name: 'File' }, TIMEOUT);
  expect(select).toHaveTextContent('a.css');
  expect(screen.queryByRole('list', { name: 'Changed files' })).not.toBeInTheDocument();
  await screen.findByText('y', { selector: 'mark' }, TIMEOUT);

  await user.click(select);
  await user.click(await screen.findByRole('option', { name: 'b.css (Removed)' }, TIMEOUT));
  expect(await screen.findByText('gone', {}, TIMEOUT)).toBeInTheDocument();
});

test('file paths and diff text render as text', async () => {
  const path = '<b>x</b>.html';
  serveCompare({
    files: [change(path)],
    texts: { [path]: { patch: '@@ -1 +1 @@\n-<p>old</p>\n+<script>alert(1)</script>\n' } },
  });
  renderRoute('/a/art_1/compare?from=2&to=3&view=files', { me: reviewer });

  await waitFor(() => expect(document.querySelector('[data-kind="add"]')).not.toBeNull(), TIMEOUT);
  expect(screen.getAllByText(path).length).toBeGreaterThan(0);
  expect(document.querySelector('[data-kind="add"]')).toHaveTextContent(
    '<script>alert(1)</script>',
  );
  expect(document.querySelector('[data-kind="del"]')).toHaveTextContent('<p>old</p>');
  expect(document.querySelector('b')).toBeNull();
  expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('[data-kind="del"] p')).toBeNull();
});

test('markdown diff HTML never enters the app document', async () => {
  serveCompare({
    kind: 'markdown',
    files: [change('index.md', 'modified', 'text/markdown; charset=utf-8'), change('logo.png')],
    markdown: {
      'index.md': {
        blocks: [
          {
            op: 'changed',
            old_html: '<img src=x onerror="window.__pwned=1">',
            new_html: '<p>B2</p>',
          },
        ],
      },
    },
  });
  const { user, router } = renderRoute('/a/art_1/compare', { me: reviewer });

  await user.click(await screen.findByRole('radio', { name: 'Rendered' }, TIMEOUT));
  await waitFor(
    () => expect(router.state.location.search).toBe('?from=2&to=3&view=rendered'),
    TIMEOUT,
  );
  const frame = await screen.findByTitle('Rendered changes in index.md', {}, TIMEOUT);
  expect(frame.tagName).toBe('IFRAME');
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.hasAttribute('src')).toBe(false);
  expect(frame.getAttribute('srcdoc')).toContain('onerror');
  expect(frame.getAttribute('srcdoc')).toContain('<p>B2</p>');
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  expect(screen.getByRole('combobox', { name: 'File' })).toHaveTextContent('index.md');
  const legend = screen.getByRole('list', { name: 'Key' });
  expect(
    within(legend)
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['+Added', '−Removed', '±Changed']);
});

test('a Markdown file too large to render falls back to the text diff', async () => {
  serveCompare({
    files: [change('notes.md', 'modified', 'text/markdown')],
    markdown: { 'notes.md': { too_large: true } },
    texts: { 'notes.md': { patch: '@@ -1 +1 @@\n-# Old\n+# New\n' } },
  });
  renderRoute('/a/art_1/compare?from=2&to=3&view=rendered', { me: reviewer });

  expect(await screen.findByText(t('web.compare.renderTooLarge'), {}, TIMEOUT)).toBeInTheDocument();
  expect(await screen.findByText('New', { selector: 'mark' }, TIMEOUT)).toBeInTheDocument();
  expect(document.querySelector('iframe[srcdoc]')).toBeNull();
});

test('a view the pair cannot show falls back to side by side', async () => {
  serveCompare({ files: [change('b')] });
  const { router } = renderRoute('/a/art_1/compare?from=2&to=3&view=rendered', { me: reviewer });
  await waitFor(() => expect(router.state.location.search).toBe('?from=2&to=3&view=side'), TIMEOUT);
});

test('compare needs two versions', async () => {
  serveCompare({ versions: [1] });
  renderRoute('/a/art_1/compare', { me: reviewer });
  expect(await screen.findByText(t('web.compare.single'), {}, TIMEOUT)).toBeInTheDocument();
  const back = screen.getAllByRole('link', { name: /Pricing/ });
  expect(back.every((link) => link.getAttribute('href') === '/a/art_1')).toBe(true);
  expect(document.querySelector('iframe')).toBeNull();
});

test('from and to can be swapped and changed', async () => {
  serveCompare();
  const { user, router } = renderRoute('/a/art_1/compare', { me: reviewer });
  await waitFor(() => expect(router.state.location.search).toBe('?from=2&to=3&view=side'), TIMEOUT);

  await user.click(screen.getByRole('button', { name: 'Swap versions' }));
  expect(router.state.location.search).toBe('?from=3&to=2&view=side');
  expect(router.state.historyAction).toBe('REPLACE');
  await frameOf(2);

  await user.click(screen.getByRole('combobox', { name: 'From' }));
  const options = await screen.findAllByRole('option', {}, TIMEOUT);
  // The current version says so in the list; the closed select shows the number alone.
  expect(options.map((o) => o.textContent)).toEqual(['v3Current', 'v2', 'v1']);
  await user.click(screen.getByRole('option', { name: 'v1' }));
  expect(router.state.location.search).toBe('?from=1&to=2&view=side');

  // Choosing the other side's version swaps them.
  await user.click(screen.getByRole('combobox', { name: 'From' }));
  await user.click(await screen.findByRole('option', { name: 'v2' }, TIMEOUT));
  expect(router.state.location.search).toBe('?from=2&to=1&view=side');

  await user.click(screen.getByRole('radio', { name: 'Files' }));
  expect(router.state.location.search).toBe('?from=2&to=1&view=files');
  expect(router.state.historyAction).toBe('REPLACE');
});
