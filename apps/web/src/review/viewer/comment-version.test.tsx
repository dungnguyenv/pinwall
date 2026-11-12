import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, expect, test, vi } from 'vitest';
import type { LiveEvent } from '../../api/dto.ts';
import i18n from '../../i18n.ts';
import { simFrame } from '../../test/annotator-sim.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import { fx } from '../../test/fixtures.ts';
import { renderRoute } from '../../test/render.tsx';
import { grantUrl, quoteOf, reviewer, serveReview, threadOn } from '../../test/review.ts';
import { API, server } from '../../test/server.ts';

// A member's thread is saved on the version whose page the spot was picked on, named by its id.

const t = (key: string, o: Record<string, unknown> = {}) => i18n.t(key, o);
const frameOf = async (n: number) =>
  (await screen.findByTitle(`Pricing, v${n}`)) as HTMLIFrameElement;
const sim = (frame: HTMLIFrameElement) => simFrame(frame.contentWindow as Window);
const send = () => screen.getByRole('button', { name: t('web.comments.post') });

/** A request that answers once `release()` is called. */
function gate() {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/** Picks a spot on the page `top` plays, in comment mode, and types `text` for it. */
async function writeOn(user: UserEvent, top: ReturnType<typeof sim>, text: string) {
  top.picked(quoteOf('Pricing'), { x: 100, y: 50 });
  const box = await screen.findByRole('textbox', { name: 'Comment' });
  await user.type(box, text);
  return box;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test('a comment on a version beyond the first page of versions is saved on that version', async () => {
  // As with more than 50 versions: the first page of the list holds v3 only.
  const s = serveReview({ versionPage: 1, threads: [threadOn(1, { id: 'cmt_a' })] });
  server.use(http.get(`${API}/artifacts/art_1/share-links`, () => HttpResponse.json(fx.page([]))));
  const { user } = renderRoute('/a/art_1/v/1', { me: reviewer });
  const top = sim(await frameOf(1));
  top.ready();

  await user.keyboard('c');
  await writeOn(user, top, 'About v1');
  await waitFor(() => expect(send()).toBeEnabled());
  await user.keyboard('{Control>}{Enter}{/Control}');
  await waitFor(() =>
    expect(s.created).toEqual([expect.objectContaining({ body: 'About v1', version_id: 'ver_1' })]),
  );
  // Read on its own, v1 is known: its threads can be resolved and a link can show it.
  expect(s.gets('/artifacts/art_1/versions/1')).toBe(1);
  const card = screen.getByRole('article', { name: 'Comment 1 by Ada' });
  expect(within(card).getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Share' }));
  const dialog = await screen.findByRole('dialog', { name: /^Share/ });
  await user.click(within(dialog).getByRole('combobox', { name: 'Link shows' }));
  expect(await screen.findByRole('option', { name: 'v1 only' })).toBeInTheDocument();
});

test('a comment cannot be sent while the id of its version is being read', async () => {
  const s = serveReview({ versionPage: 1 });
  const v1 = gate();
  server.use(
    http.get(`${API}/artifacts/art_1/versions/1`, async () => {
      await v1.opened;
      return HttpResponse.json(s.versions.find((v) => v.number === 1));
    }),
  );
  const { user } = renderRoute('/a/art_1/v/1', { me: reviewer });
  const top = sim(await frameOf(1));
  top.ready();

  await user.keyboard('c');
  const box = await writeOn(user, top, 'About v1');
  expect(send()).toBeDisabled();
  expect(screen.getByText(t('web.comments.versionLoading'))).toBeInTheDocument();
  await user.click(box);
  await user.keyboard('{Control>}{Enter}{/Control}');
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(s.created).toEqual([]);
  expect(box).toHaveValue('About v1');

  v1.release();
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.queryByText(t('web.comments.versionLoading'))).not.toBeInTheDocument();
  await user.click(send());
  await waitFor(() =>
    expect(s.created).toEqual([expect.objectContaining({ body: 'About v1', version_id: 'ver_1' })]),
  );
});

test('a version that cannot be read says why, and the comment is not sent', async () => {
  const s = serveReview({ versionPage: 1 });
  server.use(
    http.get(`${API}/artifacts/art_1/versions/1`, () =>
      HttpResponse.json(
        { error: { code: 'forbidden', message: 'You cannot read this version.' } },
        { status: 403 },
      ),
    ),
  );
  const { user } = renderRoute('/a/art_1/v/1', { me: reviewer });
  const top = sim(await frameOf(1));
  top.ready();

  await user.keyboard('c');
  await writeOn(user, top, 'About v1');
  expect(await screen.findByText('You cannot read this version.')).toBeInTheDocument();
  expect(send()).toBeDisabled();
  expect(s.created).toEqual([]);
});

test('a spot picked just before or after a switch is saved on the version its page showed', async () => {
  const s = serveReview();
  const v4 = gate();
  server.use(
    http.get(`${API}/artifacts/art_1/versions/4/preview`, async () => {
      await v4.opened;
      return HttpResponse.json(fx.grant({ url: grantUrl(4) }));
    }),
  );
  const { user } = renderRoute('/a/art_1', { me: reviewer });
  const old = sim(await frameOf(3));
  old.ready();
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error('No live stream was opened');
  act(() => source.open());
  await user.keyboard('c');

  // v4 is published and followed at once; its page is still on its way, so v3's stays.
  s.publish(4);
  const published: LiveEvent = {
    type: 'version.published',
    artifact_id: 'art_1',
    version_id: 'ver_4',
    number: 4,
  };
  act(() => source.emit(published.type, JSON.stringify(published)));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Choose version/ })).toHaveTextContent('v4'),
  );
  expect(screen.getByTitle('Pricing, v3')).toHaveAttribute('src', grantUrl(3));

  await writeOn(user, old, 'On the old page');
  await user.click(send());
  await waitFor(() =>
    expect(s.created).toEqual([
      expect.objectContaining({ body: 'On the old page', version_id: 'ver_3' }),
    ]),
  );

  // Once v4's page is in the frame, its spots go on v4.
  v4.release();
  const fresh = sim(await frameOf(4));
  fresh.ready();
  await writeOn(user, fresh, 'On the new page');
  await user.click(send());
  await waitFor(() =>
    expect(s.created.at(-1)).toEqual(
      expect.objectContaining({ body: 'On the new page', version_id: 'ver_4' }),
    ),
  );
});
