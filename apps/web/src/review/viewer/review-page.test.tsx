import type { ViewerToPageMessage } from '@pinwall/shared/protocol';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import i18n from '../../i18n.ts';
import { simFrame } from '../../test/annotator-sim.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute, setViewport } from '../../test/render.tsx';
import {
  grantUrl,
  quoteOf,
  reviewer,
  serveReview,
  threadOn,
  versionOf,
} from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';
import { CONTENT_SANDBOX } from '../frame/sandbox.ts';
import { REVIEW_SHORTCUTS } from './shortcuts.ts';

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);

const cmtA = threadOn(1, { id: 'cmt_a', created_at: 1, body: 'Bigger heading' });
const cmtB = threadOn(2, { id: 'cmt_b', created_at: 2, body: 'Swap the photo' });
const cmtC = threadOn(1, {
  id: 'cmt_c',
  created_at: 3,
  body: 'Typo in the footer',
  status: 'resolved',
  resolved_in_version: { id: 'ver_2', number: 2 },
  resolved_by: { user_id: 'usr_1', name: 'Ada' },
  resolved_at: 4,
});

const frameOf = async (n: number) =>
  (await screen.findByTitle(`Pricing, v${n}`)) as HTMLIFrameElement;
const sim = (frame: HTMLIFrameElement) => simFrame(frame.contentWindow as Window);
const versionButton = () => screen.queryByRole('button', { name: /^Choose version/ });
const panel = () => screen.queryByRole('region', { name: 'Comments' });

/** The stage measures `width` × `height`: every ResizeObserver reports that size once. */
function measureStage(width: number, height: number): void {
  const original = window.ResizeObserver;
  class Measured {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const entry = { target, contentRect: { width, height } } as unknown as ResizeObserverEntry;
      this.callback([entry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: Measured,
  });
  onTestFinished(() => {
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: original,
    });
  });
}

/** Installs the Fullscreen API: entering resolves; returns the stubs and how to take them away. */
function stubFullscreen() {
  const request = vi.fn(() => Promise.resolve());
  const exit = vi.fn(() => Promise.resolve());
  const define = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  define(HTMLElement.prototype, 'requestFullscreen', request);
  define(document, 'exitFullscreen', exit);
  const remove = () => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
    delete (document as Partial<Document>).exitFullscreen;
  };
  onTestFinished(remove);
  return { request, exit, remove };
}

/** Whether the menu opened by `trigger` has an item named `name`; leaves it closed. */
async function menuHas(user: UserEvent, trigger: HTMLElement, name: string): Promise<boolean> {
  await user.click(trigger);
  await screen.findByRole('menu');
  const found = screen.queryAllByRole('menuitem', { name }).length > 0;
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  return found;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test('opens the current version in the sandboxed frame, with the rail', async () => {
  const s = serveReview();
  renderRoute('/a/art_1', { me: reviewer });

  const frame = await frameOf(3);
  expect(frame).toHaveAttribute('src', grantUrl(3));
  expect(frame.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
  expect(frame.hasAttribute('srcdoc')).toBe(false);
  expect(s.previews).toEqual([3]);
  expect(s.requests).toContain('GET /api/v1/artifacts/art_1/versions/3/preview?mode=review');

  // The sidebar is folded to its rail.
  expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument();

  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(await within(breadcrumb).findByRole('link', { name: 'Launch site' })).toHaveAttribute(
    'href',
    '/projects/prj_2',
  );
  const heading = within(breadcrumb).getByRole('heading', { level: 1, name: 'Pricing' });
  expect(heading).toHaveAttribute('title', 'Pricing');
  expect(screen.getByRole('button', { name: 'Choose version (showing v3)' })).toHaveTextContent(
    'v3',
  );
  expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute(
    'href',
    '/a/art_1/compare?to=3',
  );
  expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  expect(document.title).toBe('Pricing · Pinwall');
});

test('opening a version moves the artifact up in Recent', async () => {
  const s = serveReview();
  server.use(http.get(`${API}/artifacts`, () => HttpResponse.json(fx.page([]))));
  const { router } = renderRoute('/', { me: reviewer });
  await waitFor(() => expect(s.gets('/artifacts/recent')).toBe(1));

  await act(() => router.navigate('/a/art_1'));
  await frameOf(3);
  // Back within a minute, the list would still be fresh: the view made it stale.
  await act(() => router.navigate('/'));
  await waitFor(() => expect(s.gets('/artifacts/recent')).toBe(2));
});

test('a version URL shows that version and offers the latest', async () => {
  const s = serveReview();
  const { user, router } = renderRoute('/a/art_1/v/1', { me: reviewer });

  expect(await frameOf(1)).toHaveAttribute('src', grantUrl(1));
  expect(s.previews).toEqual([1]);
  expect(screen.getByRole('button', { name: 'Choose version (showing v1)' })).toBeInTheDocument();
  expect(
    await screen.findByText(t('web.review.olderVersion', { number: 1, latest: 3 })),
  ).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute(
    'href',
    '/a/art_1/compare?to=1',
  );

  await user.click(screen.getByRole('link', { name: 'View latest' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'));
  expect(await frameOf(3)).toHaveAttribute('src', grantUrl(3));
  expect(
    screen.queryByText(t('web.review.olderVersion', { number: 1, latest: 3 })),
  ).not.toBeInTheDocument();
});

test('a renewed grant keeps the page on screen', async () => {
  serveReview();
  let grants = 0;
  server.use(
    http.get(`${API}/artifacts/art_1/versions/3/preview`, () => {
      grants += 1;
      return HttpResponse.json(fx.grant({ url: `https://content.example/g/v3-${grants}/` }));
    }),
  );
  const { queryClient } = renderRoute('/a/art_1', { me: reviewer });
  const frame = await frameOf(3);
  expect(frame).toHaveAttribute('src', 'https://content.example/g/v3-1/');

  // What the renewal timer does five minutes before the grant expires.
  await act(() => queryClient.refetchQueries({ queryKey: ['preview'] }));
  expect(grants).toBe(2);
  // Let the new grant reach the page.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(screen.getByTitle('Pricing, v3')).toBe(frame);
  expect(frame).toHaveAttribute('src', 'https://content.example/g/v3-1/');
});

test('the version switcher lists versions and navigates', async () => {
  const s = serveReview();
  s.versions[0] = { ...(s.versions[0] ?? versionOf(3)), message: 'Tighter pricing table' };
  s.versions[1] = { ...(s.versions[1] ?? versionOf(2)), source: 'web', created_by: 'usr_9' };
  // Two pages: the oldest version comes with Load more.
  const pages: string[] = [];
  server.use(
    http.get(`${API}/artifacts/art_1/versions`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      pages.push(cursor ?? 'first');
      return HttpResponse.json(
        cursor === 'c2' ? fx.page(s.versions.slice(2)) : fx.page(s.versions.slice(0, 2), 'c2'),
      );
    }),
  );
  const { user, router } = renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);

  await user.click(screen.getByRole('button', { name: 'Choose version (showing v3)' }));
  const v3 = await screen.findByRole('menuitemradio', { name: /^v3/ });
  expect(v3).toHaveAttribute('aria-checked', 'true');
  expect(v3).toHaveTextContent('Current');
  expect(v3).toHaveTextContent('Tighter pricing table');
  expect(v3).toHaveTextContent(t('web.review.versionBy.mine.mcp'));
  const v2 = screen.getByRole('menuitemradio', { name: /^v2/ });
  expect(v2).toHaveAttribute('aria-checked', 'false');
  expect(v2).not.toHaveTextContent('Current');
  expect(v2).toHaveTextContent(t('web.review.versionBy.other.web'));
  expect(screen.queryByRole('menuitemradio', { name: /^v1/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole('menuitem', { name: 'Load more' }));
  expect(await screen.findByRole('menuitemradio', { name: /^v1/ })).toBeInTheDocument();
  expect(pages).toEqual(['first', 'c2']);

  await user.click(screen.getByRole('menuitemradio', { name: /^v2/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1/v/2'));
  expect(await frameOf(2)).toHaveAttribute('src', grantUrl(2));

  await user.click(screen.getByRole('button', { name: 'Choose version (showing v2)' }));
  await user.click(await screen.findByRole('menuitemradio', { name: /^v3/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'));
  expect(await frameOf(3)).toBeInTheDocument();

  // [ and ] step through versions, oldest to newest.
  await user.keyboard('[[');
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1/v/2'));
  await user.keyboard(']');
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'));
});

test('device sizes resize the frame and are remembered', async () => {
  measureStage(1000, 800);
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: reviewer });

  const frame = await frameOf(3);
  expect(frame.style.width).toBe('100%');
  expect(screen.getByRole('radio', { name: 'Desktop' })).toHaveAttribute('aria-checked', 'true');

  await user.click(screen.getByRole('radio', { name: 'Tablet' }));
  expect(frame.style.width).toBe('768px');
  expect(frame.style.transform).toBe('');
  expect(localStorage.getItem('pinwall:review-device')).toBe('tablet');

  await user.click(screen.getByRole('button', { name: 'Custom width' }));
  const width = await screen.findByRole('spinbutton', { name: 'Width' });
  await user.clear(width);
  await user.type(width, '1904{Enter}');
  expect(frame.style.width).toBe('1904px');
  expect(frame.style.transform).toBe('scale(0.5)');
  expect(screen.getByText('50%')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Tablet' })).toHaveAttribute('aria-checked', 'false');
  expect(localStorage.getItem('pinwall:review-device')).toBe('custom');
  expect(localStorage.getItem('pinwall:review-width')).toBe('1904');

  // The keys pick the presets.
  await user.keyboard('3');
  expect(frame.style.width).toBe('390px');
  await user.keyboard('1');
  expect(frame.style.width).toBe('100%');
  await user.click(screen.getByRole('button', { name: 'Custom width' }));
  await user.click(await screen.findByRole('button', { name: 'Apply' }));
  expect(frame.style.width).toBe('1904px');
  cleanup();

  serveReview();
  renderRoute('/a/art_1', { me: reviewer });
  const again = await frameOf(3);
  expect(again.style.width).toBe('1904px');
  expect(again.style.transform).toBe('scale(0.5)');
});

test('the comments toggle shows open threads on this version and remembers its state', async () => {
  serveReview({ threads: [cmtA, cmtB, cmtC] });
  const { user, router } = renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);

  const toggle = screen.getByRole('button', { name: 'Comments' });
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(toggle).toHaveTextContent('2'));
  expect(toggle).toHaveAccessibleDescription(t('web.review.openCount', { count: 2 }));
  expect(panel()).toBeInTheDocument();
  expect(await screen.findByRole('article', { name: 'Comment 2 by Ada' })).toBeInTheDocument();

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(panel()).not.toBeInTheDocument();
  expect(localStorage.getItem('pinwall:review-panel:usr_1')).toBe('closed');

  // v1 has one open thread of its own.
  await act(() => router.navigate('/a/art_1/v/1'));
  await frameOf(1);
  await waitFor(() => expect(toggle).toHaveTextContent('1'));

  await user.keyboard('{Shift>}C{/Shift}');
  expect(panel()).toBeInTheDocument();
  expect(localStorage.getItem('pinwall:review-panel:usr_1')).toBe('open');
  await user.keyboard('{Shift>}C{/Shift}');
  cleanup();

  serveReview({ threads: [cmtA] });
  renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);
  expect(screen.getByRole('button', { name: 'Comments' })).toHaveAttribute('aria-pressed', 'false');
  expect(panel()).not.toBeInTheDocument();
});

test('full screen hides chrome and exits from the pill or the browser', async () => {
  serveReview({ threads: [cmtA] });
  const fs = stubFullscreen();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const frame = await frameOf(3);
  await screen.findByRole('article', { name: 'Comment 1 by Ada' });

  await user.click(screen.getByRole('button', { name: 'Comment mode' }));
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Full screen' }));
  expect(fs.request).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(versionButton()).not.toBeInTheDocument());
  expect(screen.queryByRole('heading', { name: 'Pricing' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Comment mode' })).not.toBeInTheDocument();
  expect(panel()).not.toBeInTheDocument();
  // The page stays as it was, out of comment mode.
  expect(screen.getByTitle('Pricing, v3')).toBe(frame);
  expect(frame.closest('[data-full-screen]')).toHaveAttribute('data-full-screen', 'native');
  const top = sim(frame);
  top.ready();
  expect(top.received()).toContainEqual({ pinwall: 1, type: 'set-mode', mode: 'browse' });

  await user.click(screen.getByRole('button', { name: 'Exit full screen' }));
  expect(fs.exit).toHaveBeenCalledTimes(1);
  expect(versionButton()).toBeInTheDocument();
  expect(panel()).toBeInTheDocument();

  // The browser leaves full screen by itself, on its own Esc.
  await user.keyboard('f');
  await waitFor(() => expect(versionButton()).not.toBeInTheDocument());
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(versionButton()).toBeInTheDocument();

  // A pin clicked in full screen leaves it and shows the thread.
  await user.keyboard('f');
  await waitFor(() => expect(versionButton()).not.toBeInTheDocument());
  top.pinClicked('cmt_a');
  expect(await screen.findByRole('article', { name: 'Comment 1 by Ada' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  expect(versionButton()).toBeInTheDocument();
  expect(fs.exit).toHaveBeenCalledTimes(2);

  // Without the API, a layer covers the window, and Escape leaves it.
  fs.remove();
  await user.keyboard('f');
  await waitFor(() => expect(versionButton()).not.toBeInTheDocument());
  expect(frame.closest('[data-full-screen]')).toHaveAttribute('data-full-screen', 'layer');
  expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(versionButton()).toBeInTheDocument();
  expect(frame.closest('[data-full-screen]')).toBeNull();
});

test('every shortcut has a visible control', async () => {
  serveReview({ threads: [cmtA, cmtB] });
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);
  await screen.findByRole('article', { name: 'Comment 1 by Ada' });

  const mode = screen.getByRole('button', { name: 'Comment mode' });
  expect(mode).toHaveAttribute('aria-pressed', 'false');
  expect(mode).toHaveAttribute('aria-keyshortcuts', 'C');
  await user.keyboard('c');
  expect(mode).toHaveAttribute('aria-pressed', 'true');
  await user.keyboard('{Escape}');
  expect(mode).toHaveAttribute('aria-pressed', 'false');

  // A key typed in a field is typing.
  await user.click(screen.getByRole('button', { name: 'Custom width' }));
  await user.type(await screen.findByRole('spinbutton', { name: 'Width' }), 'c');
  expect(mode).toHaveAttribute('aria-pressed', 'false');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // j and k walk the threads.
  await user.keyboard('j');
  expect(screen.getByRole('article', { name: 'Comment 1 by Ada' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await user.keyboard('j');
  expect(screen.getByRole('article', { name: 'Comment 2 by Ada' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await user.keyboard('k');
  expect(screen.getByRole('article', { name: 'Comment 1 by Ada' })).toHaveAttribute(
    'aria-current',
    'true',
  );

  await user.keyboard('?');
  const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
  expect(
    within(dialog)
      .getAllByRole('term')
      .map((term) => term.textContent),
  ).toEqual(REVIEW_SHORTCUTS.map((s) => t(s.label)));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // The frame keeps the keyboard while it has focus, so each action has a control too.
  const onPage = (name: string) =>
    ['button', 'radio', 'link'].some((role) => screen.queryAllByRole(role, { name }).length > 0);
  const missing: string[] = [];
  for (const s of REVIEW_SHORTCUTS) {
    if (s.action === 'escape' || s.action === 'shortcuts') continue;
    const name = t(s.label);
    if (onPage(name)) continue;
    const versions = screen.getByRole('button', { name: /^Choose version/ });
    if (await menuHas(user, versions, name)) continue;
    if (await menuHas(user, screen.getByRole('button', { name: 'More actions' }), name)) continue;
    missing.push(name);
  }
  expect(missing).toEqual([]);
  expect(
    await menuHas(user, screen.getByRole('button', { name: 'More actions' }), 'Keyboard shortcuts'),
  ).toBe(true);
});

test('comment mode picks open the composer beside the pin', async () => {
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const top = sim(await frameOf(3));
  top.ready();
  expect(top.received()).toContainEqual({ pinwall: 1, type: 'set-mode', mode: 'browse' });

  await user.keyboard('c');
  expect(top.received()).toContainEqual({ pinwall: 1, type: 'set-mode', mode: 'comment' });
  expect(screen.getByText(t('web.review.hint.annotator'))).toBeInTheDocument();

  top.picked(quoteOf('Pricing'), { x: 100, y: 50 });
  const box = await screen.findByRole('textbox', { name: 'Comment' });
  const card = box.closest('form');
  expect(card).toHaveStyle({ position: 'fixed' });
  expect(panel()).not.toContainElement(box);
  expect(box).toHaveFocus();
  const shows = top
    .received()
    .filter((m): m is Extract<ViewerToPageMessage, { type: 'show-anchors' }> => {
      return m.type === 'show-anchors';
    });
  expect(shows.at(-1)?.anchors.map((a) => a.id)).toContain('draft');

  // Escape in the empty composer drops it; the next leaves comment mode.
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Comment mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Comment mode' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('a page without the annotator says how comments work, once', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  serveReview();
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const frame = await frameOf(3);
  act(() => {
    frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(3000);
  });
  expect(frame.closest('[data-annotator]')).toHaveAttribute('data-annotator', 'missing');
  await user.keyboard('c');
  expect(screen.getByText(t('web.review.hint.overlay'))).toBeInTheDocument();
  // The panel says it; the overlay keeps it for the pick area's description only.
  const notices = screen.getAllByText(t('web.comments.noAnnotator'));
  expect(notices.filter((n) => !n.closest('.sr-only'))).toHaveLength(1);
});

test('loading, error and gone states', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = serveReview();
  server.use(
    http.get(`${API}/artifacts/art_1`, async () => {
      await held;
      return HttpResponse.json(s.artifact);
    }),
  );
  renderRoute('/a/art_1', { me: reviewer });
  expect(await screen.findByRole('status', { name: 'Loading artifact' })).toBeInTheDocument();
  release();
  await frameOf(3);
  cleanup();

  let failing = true;
  const again = serveReview();
  server.use(
    http.get(`${API}/artifacts/art_1`, () =>
      failing
        ? apiError(500, 'internal', 'Pinwall ran into an unexpected problem.')
        : HttpResponse.json(again.artifact),
    ),
  );
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Pinwall ran into an unexpected problem.');
  failing = false;
  await user.click(within(alert).getByRole('button', { name: 'Retry' }));
  await frameOf(3);
  cleanup();

  serveReview();
  server.use(
    http.get(`${API}/artifacts/art_1`, () => apiError(410, 'gone', 'This artifact was deleted.')),
  );
  renderRoute('/a/art_1', { me: reviewer });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Artifact not available' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('This artifact was deleted.');
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  cleanup();

  serveReview();
  renderRoute('/a/art_1/v/9', { me: reviewer });
  expect(await screen.findByText('This version does not exist.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View latest' })).toHaveAttribute('href', '/a/art_1');
  expect(screen.queryByTitle(/^Pricing, v/)).not.toBeInTheDocument();
  cleanup();

  serveReview();
  renderRoute('/a/art_1/v/0', { me: reviewer });
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
  ).toBeInTheDocument();
});

test('on a phone the panel is a bottom sheet and devices are hidden', async () => {
  setViewport(360);
  serveReview({ threads: [cmtA] });
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);

  expect(screen.getByRole('heading', { level: 1, name: 'Pricing' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Launch site' })).not.toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'Tablet' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Custom width' })).not.toBeInTheDocument();
  expect(panel()).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Comments' }));
  const sheet = await screen.findByRole('dialog', { name: 'Comments' });
  expect(
    await within(sheet).findByRole('article', { name: 'Comment 1 by Ada' }),
  ).toBeInTheDocument();
  await user.click(within(sheet).getByRole('button', { name: 'Close comments' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await screen.findByRole('menu');
  expect(screen.getByRole('menuitem', { name: 'Compare' })).toHaveAttribute(
    'href',
    '/a/art_1/compare?to=3',
  );
  expect(screen.getByRole('menuitem', { name: 'Share' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Full screen' })).toBeInTheDocument();
  await user.keyboard('{Escape}');

  // A pick on a phone writes the comment in the sheet.
  const top = sim(screen.getByTitle('Pricing, v3') as HTMLIFrameElement);
  top.ready();
  await user.click(screen.getByRole('button', { name: 'Comment mode' }));
  expect(screen.getByText(t('web.review.hint.touch'))).toBeInTheDocument();
  top.picked(quoteOf('Pricing'), { x: 100, y: 50 });
  const sheetAgain = await screen.findByRole('dialog', { name: 'Comments' });
  expect(within(sheetAgain).getByRole('textbox', { name: 'Comment' })).toBeInTheDocument();
});

test('?comment= opens that thread and focuses its pin', async () => {
  serveReview({ threads: [cmtA, cmtB] });
  localStorage.setItem('pinwall:review-panel:usr_1', 'closed');
  renderRoute('/a/art_1?comment=cmt_b', { me: reviewer });

  const card = await screen.findByRole('article', { name: 'Comment 2 by Ada' });
  await waitFor(() => expect(card).toHaveAttribute('aria-current', 'true'));
  const top = sim(await frameOf(3));
  top.ready();
  await waitFor(() =>
    expect(top.received()).toContainEqual({ pinwall: 1, type: 'focus-anchor', id: 'cmt_b' }),
  );
});

test('frame messages never trigger requests or navigation', async () => {
  const s = serveReview({ threads: [cmtA] });
  const { router } = renderRoute('/a/art_1', { me: reviewer });
  const frame = await frameOf(3);
  await screen.findByRole('article', { name: 'Comment 1 by Ada' });
  const before = s.requests.length;

  const top = sim(frame);
  top.ready();
  top.placed([{ id: 'cmt_a', found: true }]);
  top.pinClicked('cmt_a');
  top.pinClicked('cmt_unknown');
  top.picked(quoteOf('Pricing'), { x: 10, y: 10 });
  top.scrolled(0, 0.5);
  top.navigated('docs/');
  top.ready();
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

  expect(s.requests.slice(before).filter((r) => !r.startsWith('GET '))).toEqual([]);
  expect(router.state.location.pathname).toBe('/a/art_1');
  expect(router.state.location.search).toBe('');
  // A pick outside comment mode is dropped; a pin click only selects.
  expect(screen.queryByRole('textbox', { name: 'Comment' })).not.toBeInTheDocument();
  expect(screen.getByRole('article', { name: 'Comment 1 by Ada' })).toHaveAttribute(
    'aria-current',
    'true',
  );
});
