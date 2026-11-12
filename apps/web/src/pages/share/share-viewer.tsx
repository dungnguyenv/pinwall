import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client.ts';
import type { CommentThread, LiveEvent, ShareInfo } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import i18n from '../../i18n.ts';
import { PHONE_QUERY, useMediaQuery } from '../../lib/media.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { useShortcuts } from '../../lib/shortcuts.ts';
import { usePref } from '../../lib/storage.ts';
import {
  type CommentBackend,
  guestBackend,
  guestPermissions,
} from '../../review/comments/backend.ts';
import { CommentPanel } from '../../review/comments/comment-panel.tsx';
import { CommentSheet } from '../../review/comments/comment-sheet.tsx';
import { Composer } from '../../review/comments/composer.tsx';
import { composerFloats, composerPosition } from '../../review/comments/composer-position.ts';
import { GUEST_EDIT_WINDOW_MS, guestTokenFor, useGuestName } from '../../review/comments/guest.ts';
import { useReviewComments } from '../../review/comments/use-review-comments.ts';
import { ContentFrame } from '../../review/frame/content-frame.tsx';
import { CUSTOM_WIDTH, frameBox } from '../../review/frame/device.ts';
import { type PickedAnchor, useFrameBridge } from '../../review/frame/use-frame-bridge.ts';
import { followVersion } from '../../review/live/follow.ts';
import { useLiveEvents } from '../../review/live/use-live-events.ts';
import { CommentModeToggle, CommentsToggle } from '../../review/viewer/comment-toggles.tsx';
import { LiveBanner } from '../../review/viewer/live-banner.tsx';
import { keysOf } from '../../review/viewer/shortcuts.ts';
import { Stage, StagePill, useElementSize } from '../../review/viewer/stage.tsx';
import { Badge, Button, PinMark } from '../../ui/index.ts';
import { GuestNameDialog } from './guest-name-dialog.tsx';

const PANEL_STATES = ['open', 'closed'] as const;
/** Whether the comment panel shows, for every share link this browser opens. */
const PANEL_KEY = 'pinwall:share-panel';

/** An open request for the guest's name, answered by the name dialog. */
interface NameRequest {
  resolve(name: string | null): void;
  /** A name is already set: the dialog changes it. */
  change: boolean;
  /** After a save, focus goes to what the save opens rather than back to the opener. */
  returnFocus: boolean;
}

/**
 * The guest backend of link `token`, signing with `name()`. A comment or
 * reply sent before the guest has a name first asks for one; without it,
 * nothing is sent and the box keeps its text, with a word on why.
 */
function namedGuestBackend(
  token: string,
  name: () => string,
  askName: () => Promise<string | null>,
): CommentBackend {
  const guest = guestBackend(token, name);
  const named = async () => {
    if (name() !== '' || (await askName()) !== null) return;
    throw new ApiError(400, 'guest_name_required', i18n.t('web.guest.nameNeeded'));
  };
  return {
    ...guest,
    create: async (p) => {
      await named();
      return guest.create(p);
    },
    reply: async (threadId, body) => {
      await named();
      return guest.reply(threadId, body);
    },
  };
}

/**
 * Renders again when the next of this browser's own guest comments leaves its
 * 15 minutes, so its Edit and Delete go at that moment, not at the next click.
 */
function useGuestWindowEnds(threads: CommentThread[] | undefined): void {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (threads === undefined) return;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const thread of threads) {
      for (const comment of [thread, ...thread.replies]) {
        if (comment.author.type !== 'guest' || guestTokenFor(comment.id) === null) continue;
        const end = comment.created_at + GUEST_EDIT_WINDOW_MS;
        if (end > now && end < next) next = end;
      }
    }
    if (next === Number.POSITIVE_INFINITY) return;
    // A little past the end, so the clock has reached it when the render looks.
    const timer = setTimeout(rerender, next - now + 50);
    return () => clearTimeout(timer);
  });
}

/**
 * The share info on screen. It takes each new answer from the server at
 * once: a renewed grant for the same version, or the version the link shows
 * now. Only a newer version found while the guest is writing waits, as
 * `pending`, until `switchNow()`. Each move is put in `announce`.
 */
function useShownShare(
  latest: ShareInfo,
  composing: boolean,
): { info: ShareInfo; pending: number | null; switchNow(): void; announce: string | null } {
  const { t } = useTranslation();
  const [state, setState] = useState<{ info: ShareInfo; announce: string | null }>({
    info: latest,
    announce: null,
  });
  const switched = (number: number) => t('web.review.live.switched', { number });

  let { info, announce } = state;
  let pending: number | null = null;
  if (info !== latest) {
    const next = followVersion({
      follow: latest.follows_current,
      shown: info.version_number,
      current: latest.version_number,
      composing,
    });
    if (next.pending === null) {
      if (latest.version_number !== info.version_number) announce = switched(latest.version_number);
      info = latest;
      // Adjusting state during render: React renders again at once with it.
      setState({ info, announce });
    } else {
      pending = next.pending;
    }
  }

  return {
    info,
    pending,
    switchNow: () => setState({ info: latest, announce: switched(latest.version_number) }),
    announce,
  };
}

/**
 * A share link's page for its guests: a slim bar (the Pinwall pin, the
 * artifact's name, the version, Open original, and with comments allowed,
 * comment mode and the comments) over the page, which fills the rest. Guests
 * comment under a name they give once, kept in this browser; they change
 * what they wrote for 15 minutes and resolve nothing. Live updates follow the
 * link: a link to the latest version moves to each new one, unless the guest
 * is writing, when it offers the switch. Nothing here needs an account or
 * reads one.
 */
export function ShareViewer({
  token,
  info: latest,
}: {
  token: string;
  info: ShareInfo;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const phone = useMediaQuery(PHONE_QUERY);

  const [composing, setComposing] = useState(false);
  const view = useShownShare(latest, composing);
  const info = view.info;
  const comments = info.allow_comments;
  usePageTitle(info.artifact_name);

  // The guest's name. The backend reads it as it sends, so it takes the newest one.
  const [name, setName] = useGuestName();
  const nameRef = useRef(name);
  useLayoutEffect(() => {
    nameRef.current = name;
  });
  const [request, setRequest] = useState<NameRequest | null>(null);
  const requestRef = useRef<NameRequest | null>(null);
  const askName = useCallback(
    (o: { returnFocus: boolean }) =>
      new Promise<string | null>((resolve) => {
        // A new question replaces one still open, which then goes unanswered.
        requestRef.current?.resolve(null);
        const next = { resolve, change: nameRef.current !== '', returnFocus: o.returnFocus };
        requestRef.current = next;
        setRequest(next);
      }),
    [],
  );
  const answer = (given: string | null) => {
    const open = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    if (given !== null) {
      setName(given);
      // Read at once by a send that waited for it.
      nameRef.current = given;
    }
    open?.resolve(given);
  };
  /** Runs `then` once the guest has a name, asking for one first if needed. */
  const withName = (returnFocus: boolean, then: () => void) => {
    if (nameRef.current !== '') then();
    else
      void askName({ returnFocus }).then((given) => {
        if (given !== null) then();
      });
  };

  // Comments.
  const backend = useMemo(
    () =>
      namedGuestBackend(
        token,
        () => nameRef.current,
        () => askName({ returnFocus: true }),
      ),
    [token, askName],
  );
  const permissions = useMemo(() => guestPermissions(Date.now), []);
  const c = useReviewComments({
    backend,
    permissions,
    shown: info.version_number,
    // Guests resolve nothing, and the server puts their threads on the version the link shows.
    versionId: null,
    filterPrefKey: null,
    enabled: comments,
  });
  if (c.composing !== composing) setComposing(c.composing);
  useGuestWindowEnds(c.query.data);

  // Layout: the panel, or the sheet on a phone, and comment mode.
  const [panelPref, setPanelPref] = usePref(PANEL_KEY, PANEL_STATES, 'open');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const layout = phone ? 'sheet' : 'dock';
  const docked = comments && !phone && panelPref === 'open';
  const mode = comments && commentMode ? 'comment' : 'browse';
  const stageRef = useRef<HTMLDivElement>(null);
  const box = frameBox('desktop', CUSTOM_WIDTH.default, useElementSize(stageRef));

  const showComments = () => {
    if (phone) setSheetOpen(true);
    else setPanelPref('open');
  };

  // The composer floats beside a pick on the page; anywhere else it heads the panel or sheet.
  const [floatAt, setFloatAt] = useState<{ left: number; top: number } | null>(null);
  const place = (p: PickedAnchor) => {
    c.startDraft(p);
    if (composerFloats(p, layout) && p.client !== null) {
      const frame = stageRef.current?.querySelector('[data-annotator]');
      const rect = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
      setFloatAt(
        composerPosition(p.client, rect, box.scale, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    } else {
      showComments();
    }
  };
  const onPicked = (p: PickedAnchor) => withName(false, () => place(p));
  const onPinClicked = (id: string) => {
    c.select(id);
    showComments();
  };

  const bridge = useFrameBridge(info.content.url, {
    pins: c.pins,
    mode,
    version: info.version_number,
    expiresAt: info.content.expires_at,
    onPicked,
    onPinClicked,
  });

  // Live updates. What the link shows is the server's to say: read the info again.
  const refresh = (o: { threads: boolean }) => {
    void queryClient.invalidateQueries({ queryKey: qk.shareInfo(token) });
    if (o.threads) void queryClient.invalidateQueries({ queryKey: qk.threads(backend.scope) });
  };
  const liveStatus = useLiveEvents(backend.eventsPath, {
    onEvent: (e: LiveEvent) => {
      switch (e.type) {
        case 'version.published':
        case 'artifact.deleted':
          refresh({ threads: false });
          break;
        case 'version.deleted':
          // Its threads went with it.
          refresh({ threads: true });
          break;
        default:
          c.applyLive(e);
      }
    },
    onResync: () => refresh({ threads: true }),
  });

  // Actions, shared by the controls and the keys.
  const toggleCommentMode = () => setCommentMode((on) => !on);
  const addComment = () => {
    setSheetOpen(false);
    withName(true, () => setCommentMode(true));
  };
  const toggleComments = () => {
    if (phone) setSheetOpen((open) => !open);
    else setPanelPref(panelPref === 'open' ? 'closed' : 'open');
  };
  const pressEscape = () => {
    if (c.draft !== null) {
      // Unsent words are never dropped by a key: the box holding them takes focus instead.
      if (c.text('new').trim() === '') c.cancelDraft();
      else
        stageRef.current?.ownerDocument
          .querySelector<HTMLTextAreaElement>(
            `textarea[aria-label="${t('web.comments.composerLabel')}"]`,
          )
          ?.focus();
    } else {
      setCommentMode(false);
    }
  };
  useShortcuts([
    { keys: keysOf('commentMode'), run: toggleCommentMode, enabled: comments },
    { keys: keysOf('escape'), run: pressEscape, enabled: c.draft !== null || mode === 'comment' },
  ]);

  const floating =
    c.draft !== null && composerFloats(c.draft, layout) && floatAt !== null ? floatAt : null;
  const hint = phone
    ? bridge.annotator === 'missing'
      ? 'web.review.hint.overlayTouch'
      : 'web.review.hint.touch'
    : bridge.annotator === 'missing'
      ? 'web.review.hint.overlay'
      : 'web.review.hint.annotator';

  const footer =
    name === '' ? null : (
      <p className="flex shrink-0 items-center gap-1.5 border-border border-t px-4 py-2.5 text-fg-muted text-sm">
        <span className="min-w-0 truncate">{t('web.guest.commentingAs', { name })}</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => void askName({ returnFocus: true })}
          className="shrink-0 cursor-pointer rounded-sm font-medium text-accent-text hover:underline hover:underline-offset-2"
        >
          {t('web.guest.change')}
        </button>
      </p>
    );

  const panel = comments ? (
    <CommentPanel
      c={c}
      bridge={bridge}
      shown={info.version_number}
      variant={layout}
      liveStatus={liveStatus}
      onAddComment={addComment}
      onClose={() => (phone ? setSheetOpen(false) : setPanelPref('closed'))}
      footer={footer}
    />
  ) : null;

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <ShareBar
        info={info}
        comments={comments}
        commentMode={commentMode}
        onCommentMode={toggleCommentMode}
        commentsOpen={phone ? sheetOpen : panelPref === 'open'}
        openCount={c.query.data === undefined ? null : c.counts.open}
        onComments={toggleComments}
      />
      <main className="flex min-h-0 flex-1">
        <Stage
          stageRef={stageRef}
          framed={false}
          commenting={mode === 'comment'}
          notices={
            <>
              <LiveBanner pending={view.pending} onSwitch={view.switchNow} />
              {mode === 'comment' ? <StagePill tone="accent">{t(hint)}</StagePill> : null}
            </>
          }
        >
          <ContentFrame
            bridge={bridge}
            title={t('web.review.frameTitle', {
              name: info.artifact_name,
              number: info.version_number,
            })}
            box={box}
            pins={c.pins}
            mode={mode}
            onPicked={onPicked}
            onPinClicked={onPinClicked}
            // The docked panel says what the overlay would.
            overlayNote={!docked}
          />
        </Stage>
        {docked ? (
          <div className="w-(--review-panel-width) max-w-[50%] shrink-0 animate-panel-in">
            {panel}
          </div>
        ) : null}
      </main>
      {phone && panel ? (
        <CommentSheet open={sheetOpen} onOpenChange={setSheetOpen} title={t('web.comments.title')}>
          {panel}
        </CommentSheet>
      ) : null}
      {floating ? (
        <Composer
          c={c}
          number={c.shownAll.length + 1}
          floating={floating}
          onPosted={(thread) => bridge.focus(thread.id)}
        />
      ) : null}
      <GuestNameDialog
        open={request !== null}
        change={request?.change ?? false}
        initial={name}
        returnFocus={request?.returnFocus ?? true}
        onSave={answer}
        onCancel={() => answer(null)}
      />
      <p role="status" className="sr-only">
        {view.announce}
      </p>
    </div>
  );
}

/**
 * The share viewer's bar: the Pinwall pin, the artifact's name as the page's
 * heading, the version (marked Latest when the link follows new versions),
 * then Open original, and comment mode and the comments when the link allows
 * them. No way into the app: guests have no account.
 */
function ShareBar({
  info,
  comments,
  commentMode,
  onCommentMode,
  commentsOpen,
  openCount,
  onComments,
}: {
  info: ShareInfo;
  comments: boolean;
  commentMode: boolean;
  onCommentMode(): void;
  commentsOpen: boolean;
  openCount: number | null;
  onComments(): void;
}) {
  const { t } = useTranslation();
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-border border-b bg-canvas pr-2 pl-3 md:gap-1.5 md:pr-3">
      <PinMark size={20} title={t('app.name')} />
      <div className="ml-1.5 flex min-w-0 items-center gap-2">
        <h1 title={info.artifact_name} className="min-w-0 truncate font-semibold text-fg text-md">
          {info.artifact_name}
        </h1>
        <span className="shrink-0 text-fg-muted text-sm tabular-nums">
          {t('web.share.viewer.version', { number: info.version_number })}
        </span>
        {info.follows_current ? (
          <span title={t('web.share.viewer.latestHint')} className="flex shrink-0">
            <Badge tone="accent">{t('web.share.viewer.latest')}</Badge>
          </span>
        ) : null}
      </div>
      <div className="min-w-2 flex-1" />
      <Button
        asChild
        variant="ghost"
        size="sm"
        leadingIcon={<ExternalLink />}
        className="px-2.5 text-fg-muted hover:text-fg"
      >
        <a href={info.original_url} target="_blank" rel="noopener noreferrer">
          <span className="max-md:sr-only">{t('web.share.viewer.openOriginal')}</span>
        </a>
      </Button>
      {comments ? <CommentModeToggle on={commentMode} onToggle={onCommentMode} /> : null}
      {comments ? (
        <CommentsToggle open={commentsOpen} count={openCount} onToggle={onComments} />
      ) : null}
    </header>
  );
}
