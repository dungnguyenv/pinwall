import type { ViewerToPageMessage } from '@pinwall/shared/protocol';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { LiveEvent } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { browser } from '../../lib/navigation.ts';
import { simFrame } from '../../test/annotator-sim.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import { renderRoute } from '../../test/render.tsx';
import { grantUrl, quoteOf, reviewer, serveReview, threadOn } from '../../test/review.ts';
import { API, apiError, server } from '../../test/server.ts';

const frameOf = async (n: number) =>
  (await screen.findByTitle(`Pricing, v${n}`)) as HTMLIFrameElement;
const sim = (frame: HTMLIFrameElement) => simFrame(frame.contentWindow as Window);

/** The stream the review screen opened last. */
function stream(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error('No live stream was opened');
  return source;
}

function emit(e: LiveEvent): void {
  act(() => stream().emit(e.type, JSON.stringify(e)));
}

const published = (n: number): LiveEvent => ({
  type: 'version.published',
  artifact_id: 'art_1',
  version_id: `ver_${n}`,
  number: n,
});

function anchorIds(messages: ViewerToPageMessage[]): string[] | undefined {
  const shows = messages.filter(
    (m): m is Extract<ViewerToPageMessage, { type: 'show-anchors' }> => m.type === 'show-anchors',
  );
  return shows.at(-1)?.anchors.map((a) => a.id);
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test('a publish while following switches without a reload', async () => {
  const s = serveReview({ versions: [1], threads: [threadOn(1, { id: 't1' })] });
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  renderRoute('/a/art_1', { me: reviewer });
  await frameOf(1);
  await screen.findByRole('article', { name: 'Comment 1 by Ada' });
  expect(stream().url).toBe('http://localhost:3000/api/v1/artifacts/art_1/events');
  act(() => stream().open());

  s.publish(2);
  emit(published(2));

  const frame = await frameOf(2);
  expect(frame).toHaveAttribute('src', grantUrl(2));
  expect(s.previews).toEqual([1, 2]);
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByRole('article', { name: 'Comment 1 by Ada' })).toBeInTheDocument();
  const announced = await screen.findByText(i18n.t('web.review.live.switched', { number: 2 }));
  expect(announced.closest('[role="status"]')).not.toBeNull();

  const top = sim(frame);
  top.ready();
  expect(anchorIds(top.received())).toEqual(['t1']);
});

test('a publish during a draft offers to switch', async () => {
  const s = serveReview({ versions: [1] });
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const top = sim(await frameOf(1));
  top.ready();
  act(() => stream().open());

  await user.keyboard('c');
  top.picked(quoteOf('Pricing'), { x: 100, y: 50 });
  await user.type(await screen.findByRole('textbox', { name: 'Comment' }), 'Fix');

  s.publish(2);
  emit(published(2));
  const banner = await screen.findByText(i18n.t('web.review.live.published', { number: 2 }));
  expect(banner.closest('[role="status"]')).not.toBeNull();
  // The page and the draft stay as they are.
  await waitFor(() => expect(s.gets('/artifacts/art_1')).toBe(2));
  expect(screen.getByTitle('Pricing, v1')).toHaveAttribute('src', grantUrl(1));
  expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Fix');

  await user.click(screen.getByRole('button', { name: 'Switch' }));
  expect(await frameOf(2)).toHaveAttribute('src', grantUrl(2));
  expect(
    screen.queryByText(i18n.t('web.review.live.published', { number: 2 })),
  ).not.toBeInTheDocument();
  const box = screen.getByRole('textbox', { name: 'Comment' });
  expect(box).toHaveValue('Fix');

  // Sent after the switch, it still goes on the version its spot was picked on.
  await user.click(box);
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() =>
    expect(s.created).toEqual([expect.objectContaining({ body: 'Fix', version_id: 'ver_1' })]),
  );
});

test('deleting the shown version moves a follower and stops a pinned viewer', async () => {
  const s = serveReview();
  renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);
  act(() => stream().open());
  s.remove(3);
  emit({ type: 'version.deleted', artifact_id: 'art_1', number: 3 });
  expect(await frameOf(2)).toHaveAttribute('src', grantUrl(2));
  cleanup();

  const again = serveReview();
  const { user, router } = renderRoute('/a/art_1/v/2', { me: reviewer });
  await frameOf(2);
  act(() => stream().open());
  again.remove(2);
  emit({ type: 'version.deleted', artifact_id: 'art_1', number: 2 });
  expect(
    await screen.findByText(i18n.t('web.review.versionGone', { number: 2 })),
  ).toBeInTheDocument();
  expect(screen.queryByTitle('Pricing, v2')).not.toBeInTheDocument();

  await user.click(screen.getByRole('link', { name: 'View latest' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/a/art_1'));
  expect(await frameOf(3)).toHaveAttribute('src', grantUrl(3));
});

test('an ended stream resyncs the artifact and threads', async () => {
  // The first reconnect waits its shortest: 800 ms.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const s = serveReview({ threads: [threadOn(1, { id: 't1' })] });
  const { router } = renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);
  await screen.findByRole('article', { name: 'Comment 1 by Ada' });
  act(() => stream().open());
  const artifactReads = s.gets('/artifacts/art_1');
  const threadReads = s.gets('/artifacts/art_1/comments');

  act(() => stream().fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  act(() => stream().open());
  await waitFor(() => {
    expect(s.gets('/artifacts/art_1')).toBeGreaterThan(artifactReads);
    expect(s.gets('/artifacts/art_1/comments')).toBeGreaterThan(threadReads);
  });

  // The stream ends because the session did: reading the artifact again leads to sign in.
  server.use(
    http.head(`${API}/artifacts/art_1/events`, () => new HttpResponse(null, { status: 401 })),
    http.get(`${API}/artifacts/art_1`, () => apiError(401, 'unauthorized', 'Sign in to continue.')),
  );
  act(() => stream().fail(2));
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(router.state.location.search).toBe('?return_to=%2Fa%2Fart_1');
});

test('artifact.deleted shows the deleted state', async () => {
  serveReview();
  renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);
  act(() => stream().open());

  emit({ type: 'artifact.deleted', artifact_id: 'art_1' });
  expect(await screen.findByText(i18n.t('web.review.artifactGone'))).toBeInTheDocument();
  expect(await screen.findByRole('link', { name: 'Go to Launch site' })).toHaveAttribute(
    'href',
    '/projects/prj_2',
  );
  expect(screen.queryByTitle(/^Pricing, v/)).not.toBeInTheDocument();
  expect(stream().close).toHaveBeenCalled();
});

test('comment events from others update the panel', async () => {
  const s = serveReview({ threads: [threadOn(1, { id: 't1', created_at: 1 })] });
  renderRoute('/a/art_1', { me: reviewer });
  await frameOf(3);
  await screen.findByRole('article', { name: 'Comment 1 by Ada' });
  act(() => stream().open());
  const reads = s.gets('/artifacts/art_1/comments');

  const lan = threadOn(1, {
    id: 't2',
    created_at: 2,
    author: { type: 'guest', name: 'Lan' },
    body: 'Màu nền tối quá',
  });
  emit({ type: 'comment.created', artifact_id: 'art_1', thread: lan });
  expect(await screen.findByRole('article', { name: 'Comment 2 by Lan' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Comments/ })).toHaveTextContent('2');
  expect(s.gets('/artifacts/art_1/comments')).toBe(reads);
});
