import { useQueryClient } from '@tanstack/react-query';
import { Minimize } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import type { ArtifactSummary, ContentGrant, LiveEvent, Me } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { useArtifact, useProject } from '../../api/library.ts';
import { useMe } from '../../api/session.ts';
import { reviewPath, useReviewGrant, useVersions } from '../../api/versions.ts';
import { PageHeader } from '../../app/shell/page-header.tsx';
import { PHONE_QUERY, useMediaQuery } from '../../lib/media.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { type Shortcut, useShortcuts } from '../../lib/shortcuts.ts';
import { readText, usePref, writeText } from '../../lib/storage.ts';
import { LibraryPage, PageError } from '../../pages/library-page.tsx';
import { NotFoundPage } from '../../pages/not-found-page.tsx';
import { Button, cn, ErrorState, LoadingRegion, Skeleton } from '../../ui/index.ts';
import { memberBackend, memberPermissions } from '../comments/backend.ts';
import { CommentPanel } from '../comments/comment-panel.tsx';
import { CommentSheet } from '../comments/comment-sheet.tsx';
import { Composer } from '../comments/composer.tsx';
import { composerFloats, composerPosition } from '../comments/composer-position.ts';
import { useReviewComments } from '../comments/use-review-comments.ts';
import { ContentFrame } from '../frame/content-frame.tsx';
import { CUSTOM_WIDTH, clampCustomWidth, type Device, frameBox } from '../frame/device.ts';
import { type PickedAnchor, useFrameBridge } from '../frame/use-frame-bridge.ts';
import { useLiveEvents } from '../live/use-live-events.ts';
import { useFullScreen } from './full-screen.ts';
import { LiveBanner } from './live-banner.tsx';
import { REVIEW_SHORTCUTS, type ReviewAction } from './shortcuts.ts';
import { ShortcutsDialog } from './shortcuts-dialog.tsx';
import { Stage, StageMessage, StagePill, useElementSize } from './stage.tsx';
import { TopBar } from './top-bar.tsx';
import { useShownVersion } from './use-shown-version.ts';

const VERSION_NUMBER = /^[1-9]\d*$/;
const PANEL_STATES = ['open', 'closed'] as const;
const DEVICES: readonly Device[] = ['desktop', 'tablet', 'phone', 'custom'];
const DEVICE_KEY = 'pinwall:review-device';
const WIDTH_KEY = 'pinwall:review-width';
/** How long the Exit full screen pill stays after the pointer last moved. */
const PILL_MS = 2500;

/** The custom width kept from an earlier visit, or the default. */
function storedWidth(): number {
  const n = Number.parseInt(readText(WIDTH_KEY, { max: 6 }) ?? '', 10);
  return Number.isNaN(n) ? CUSTOM_WIDTH.default : clampCustomWidth(n);
}

/**
 * The review screen: `/a/:artifactId` follows the current version,
 * `/a/:artifactId/v/:n` shows version n. An address with a malformed version
 * number names no page.
 */
export function ReviewPage(): ReactElement {
  const { artifactId = '', n } = useParams();
  if (n !== undefined && !VERSION_NUMBER.test(n)) return <NotFoundPage />;
  return (
    <ReviewScreen
      key={artifactId}
      artifactId={artifactId}
      versionParam={n === undefined ? null : Number(n)}
    />
  );
}

/** The artifact's loading, failure and deletion, around the review itself. */
function ReviewScreen({
  artifactId,
  versionParam,
}: {
  artifactId: string;
  versionParam: number | null;
}) {
  const { t } = useTranslation();
  const query = useArtifact(artifactId);
  const me = useMe().data;
  const [deleted, setDeleted] = useState(false);
  usePageTitle(query.data?.name ?? null);
  const onDeleted = useCallback(() => setDeleted(true), []);

  // Gone since it was read: a refetch that finds it deleted counts as much as the event.
  const gone = query.isError && (query.error.status === 404 || query.error.status === 410);
  if (deleted && query.data) return <ArtifactGone artifact={query.data} />;
  if (!query.data || gone || !me) {
    if (query.isError) {
      return (
        <LibraryPage>
          <div className="pt-5 md:pt-8">
            <PageError
              error={query.error}
              unavailableTitle={t('web.artifact.unavailable')}
              onRetry={() => void query.refetch()}
            />
          </div>
        </LibraryPage>
      );
    }
    return <ReviewSkeleton />;
  }
  return <Review artifact={query.data} me={me} versionParam={versionParam} onDeleted={onDeleted} />;
}

/** The bar and the stage, as grey shapes while the artifact loads. */
function ReviewSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.artifact.loading')}>
      <div className="flex h-dvh flex-col max-md:h-[calc(100dvh-var(--topbar-height))]">
        <div className="flex h-(--topbar-height) shrink-0 items-center gap-3 border-border border-b px-3">
          <Skeleton className="h-4 w-48 max-w-[40%]" />
          <Skeleton className="h-6 w-10" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-28 max-md:hidden" />
          <Skeleton className="h-7 w-16" />
        </div>
        <div className="min-h-0 flex-1 bg-surface-muted" />
      </div>
    </LoadingRegion>
  );
}

/** What a reviewer sees once the artifact is deleted under them. */
function ArtifactGone({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation();
  const project = useProject(artifact.project_id);
  return (
    <LibraryPage>
      <div className="pt-5 md:pt-8">
        <PageHeader
          title={t('web.artifact.unavailable')}
          description={<span role="alert">{t('web.review.artifactGone')}</span>}
        >
          <div>
            <Button asChild variant="secondary">
              {project.data ? (
                <Link to={`/projects/${encodeURIComponent(project.data.id)}`}>
                  {t('web.review.goToProject', { project: project.data.name })}
                </Link>
              ) : (
                <Link to="/">{t('web.review.goToProjects')}</Link>
              )}
            </Button>
          </div>
        </PageHeader>
      </div>
    </LibraryPage>
  );
}

/**
 * The review of one artifact: the bar, the page on its stage with the
 * comments' pins, the comment panel, full screen, the keys, and live updates.
 * Messages from the page change only what is shown here; every request and
 * navigation starts from the reviewer's own action or from the live stream.
 */
function Review({
  artifact,
  me,
  versionParam,
  onDeleted,
}: {
  artifact: ArtifactSummary;
  me: Me;
  versionParam: number | null;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const phone = useMediaQuery(PHONE_QUERY);
  const artifactId = artifact.id;
  const current = artifact.current_version?.number ?? null;

  // What is shown: following the current version, or the one in the address.
  const [composing, setComposing] = useState(false);
  const view = useShownVersion(artifact, versionParam, composing);
  const shown = view.shown;
  const [goneNumber, setGoneNumber] = useState<number | null>(null);
  const versionGone = goneNumber !== null && goneNumber === versionParam;

  const versions = useVersions(artifactId);
  const versionList = useMemo(
    () => versions.data?.pages.flatMap((page) => page.items) ?? [],
    [versions.data],
  );
  const shownVersion =
    shown === null
      ? null
      : artifact.current_version?.number === shown
        ? artifact.current_version
        : (versionList.find((v) => v.number === shown) ?? null);
  const older = shown === null ? null : (versionList.find((v) => v.number < shown)?.number ?? null);
  const newer =
    shown === null ? null : (versionList.findLast((v) => v.number > shown)?.number ?? null);

  // Comments.
  const backend = useMemo(() => memberBackend(artifactId), [artifactId]);
  const permissions = useMemo(
    () => memberPermissions(me, { created_by: artifact.created_by }),
    [me, artifact.created_by],
  );
  const c = useReviewComments({
    backend,
    permissions,
    shown: shown ?? 0,
    versionId: shownVersion?.id ?? null,
    filterPrefKey: `pinwall:comment-filter:${me.id}`,
  });
  if (c.composing !== composing) setComposing(c.composing);

  // Layout: the panel, the sheet, the device and full screen.
  const [panelPref, setPanelPref] = usePref(`pinwall:review-panel:${me.id}`, PANEL_STATES, 'open');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [device, setDevice] = usePref<Device>(DEVICE_KEY, DEVICES, 'desktop');
  const [customWidth, setCustomWidth] = useState(storedWidth);
  const [commentMode, setCommentMode] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fs = useFullScreen(rootRef);
  const full = fs.active;
  const layout = phone ? 'sheet' : 'dock';
  const docked = !phone && !full && panelPref === 'open';
  const mode = commentMode && !full ? 'comment' : 'browse';
  const stageSize = useElementSize(stageRef);
  // A phone's screen is the phone: the page fills it.
  const box = frameBox(phone ? 'desktop' : device, customWidth, stageSize);

  // The page's content grant. The page on screen stays until the next version's grant is
  // there, so a switch never shows an empty stage.
  const grant = useReviewGrant(artifactId, versionGone ? null : shown);
  const grantFailed = grant.isError && grant.data === undefined;
  const [held, setHeld] = useState<{ n: number; grant: ContentGrant } | null>(null);
  if (grant.data && shown !== null && held?.grant !== grant.data) {
    setHeld({ n: shown, grant: grant.data });
  }
  // Opening a version counts as a view of the artifact, which moves it up in Recent.
  useEffect(() => {
    if (grant.data) void queryClient.invalidateQueries({ queryKey: qk.recent });
  }, [grant.data, queryClient]);

  const showComments = useCallback(() => {
    if (phone) setSheetOpen(true);
    else setPanelPref('open');
  }, [phone, setPanelPref]);

  // The composer floats beside a pick on the page; anywhere else it heads the panel or sheet.
  const [floatAt, setFloatAt] = useState<{ left: number; top: number } | null>(null);
  const onPicked = (p: PickedAnchor) => {
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
  const onPinClicked = (id: string) => {
    fs.exit();
    c.select(id);
    showComments();
  };

  const bridge = useFrameBridge(held?.grant.url ?? '', {
    pins: c.pins,
    mode,
    version: held?.n,
    expiresAt: held?.grant.expires_at,
    onPicked,
    onPinClicked,
  });

  // `?comment=<id>`: select that thread once the threads are read, then show its pin.
  const deepLink = searchParams.get('comment');
  const deepLinkStep = useRef<'select' | 'focus' | 'done'>(deepLink === null ? 'done' : 'select');
  useEffect(() => {
    if (deepLink === null || c.query.data === undefined || shown === null) return;
    if (deepLinkStep.current === 'select') {
      if (c.shownAll.some((thread) => thread.id === deepLink)) {
        c.select(deepLink);
        showComments();
        deepLinkStep.current = 'focus';
      } else {
        deepLinkStep.current = 'done';
      }
    } else if (
      deepLinkStep.current === 'focus' &&
      bridge.src !== '' &&
      c.pins.some((pin) => pin.id === deepLink)
    ) {
      deepLinkStep.current = 'done';
      bridge.focus(deepLink);
    }
  });

  // Live updates.
  const invalidate = (...keys: (readonly unknown[])[]) => {
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
  const liveStatus = useLiveEvents(backend.eventsPath, {
    onEvent: (e: LiveEvent) => {
      switch (e.type) {
        case 'version.published':
          invalidate(qk.artifact(artifactId), qk.versions(artifactId));
          break;
        case 'version.deleted':
          if (e.number === versionParam) setGoneNumber(e.number);
          invalidate(qk.artifact(artifactId), qk.versions(artifactId), qk.threads(backend.scope));
          break;
        case 'artifact.deleted':
          void queryClient.invalidateQueries({ queryKey: qk.artifactLists, refetchType: 'none' });
          onDeleted();
          break;
        default:
          c.applyLive(e);
      }
    },
    onResync: () =>
      invalidate(qk.artifact(artifactId), qk.versions(artifactId), qk.threads(backend.scope)),
  });

  // Actions, shared by the controls and the keys.
  const goToVersion = (n: number) => {
    if (n === current && view.follow) view.switchNow();
    else void navigate(reviewPath(artifactId, n === current ? null : n));
  };
  const toggleCommentMode = () => setCommentMode((on) => !on);
  const toggleComments = () => {
    if (phone) setSheetOpen((open) => !open);
    else setPanelPref(panelPref === 'open' ? 'closed' : 'open');
  };
  const chooseDevice = (d: Device) => setDevice(d);
  const chooseCustomWidth = (n: number) => {
    setCustomWidth(n);
    writeText(WIDTH_KEY, String(n));
    setDevice('custom');
  };
  const step = (by: 1 | -1) => {
    const list = c.visible;
    if (list.length === 0) return;
    const at = list.findIndex((thread) => thread.id === c.selectedId);
    const next =
      at === -1 ? (by === 1 ? 0 : list.length - 1) : (at + by + list.length) % list.length;
    const thread = list[next];
    if (thread === undefined) return;
    c.select(thread.id);
    bridge.focus(thread.id);
  };
  const enterFullScreen = () => {
    setCommentMode(false);
    fs.enter();
  };
  const openShortcuts = () => {
    // Nothing shows above the browser's full screen but the page itself.
    fs.exit();
    setShortcutsOpen(true);
  };
  const composerBox = () =>
    rootRef.current?.ownerDocument.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${t('web.comments.composerLabel')}"]`,
    );
  const pressEscape = () => {
    if (full) {
      fs.exit();
    } else if (c.draft !== null) {
      // Unsent words are never dropped by a key: the box holding them takes focus instead.
      if (c.text('new').trim() === '') c.cancelDraft();
      else composerBox()?.focus();
    } else if (commentMode) {
      setCommentMode(false);
    }
  };

  const actions: Record<ReviewAction, { run(): void; enabled: boolean }> = {
    commentMode: { run: toggleCommentMode, enabled: !full && permissions.canComment },
    togglePanel: { run: toggleComments, enabled: !full },
    nextThread: { run: () => step(1), enabled: true },
    prevThread: { run: () => step(-1), enabled: true },
    prevVersion: { run: () => older !== null && goToVersion(older), enabled: older !== null },
    nextVersion: { run: () => newer !== null && goToVersion(newer), enabled: newer !== null },
    desktop: { run: () => chooseDevice('desktop'), enabled: !phone },
    tablet: { run: () => chooseDevice('tablet'), enabled: !phone },
    phone: { run: () => chooseDevice('phone'), enabled: !phone },
    fullScreen: { run: () => (full ? fs.exit() : enterFullScreen()), enabled: true },
    shortcuts: { run: openShortcuts, enabled: true },
    // Otherwise Escape is left to whatever else wants it.
    escape: { run: pressEscape, enabled: full || c.draft !== null || commentMode },
  };
  useShortcuts(
    REVIEW_SHORTCUTS.map(
      (s): Shortcut => ({
        keys: s.keys,
        run: actions[s.action].run,
        enabled: actions[s.action].enabled,
      }),
    ),
  );

  const latestHref = reviewPath(artifactId);
  const compareHref = `${reviewPath(artifactId)}/compare?to=${shown ?? current ?? ''}`;
  const floating =
    !full && c.draft !== null && composerFloats(c.draft, layout) && floatAt !== null
      ? floatAt
      : null;

  const stageContent = (() => {
    if (versionGone && goneNumber !== null) {
      return (
        <StageMessage
          title={t('web.review.versionGone', { number: goneNumber })}
          action={<ViewLatest href={latestHref} />}
        />
      );
    }
    if (shown === null) return <StageMessage title={t('web.review.noVersion')} />;
    if (grantFailed && grant.isError) {
      const status = grant.error.status;
      if (status === 404 || status === 410) {
        return (
          <StageMessage
            title={t('web.review.previewFailed')}
            message={errorMessage(grant.error, t)}
            action={<ViewLatest href={latestHref} />}
          />
        );
      }
      return (
        <div className="grid size-full place-items-center">
          <ErrorState
            title={t('web.review.previewFailed')}
            message={errorMessage(grant.error, t)}
            onRetry={() => void grant.refetch()}
          />
        </div>
      );
    }
    if (held === null) return null;
    return (
      <ContentFrame
        bridge={bridge}
        title={t('web.review.frameTitle', { name: artifact.name, number: held.n })}
        box={box}
        pins={c.pins}
        mode={mode}
        onPicked={onPicked}
        onPinClicked={onPinClicked}
        // The docked panel says what the overlay would.
        overlayNote={!docked}
        className={box.framed ? 'rounded-md shadow-dialog ring-1 ring-border' : undefined}
      />
    );
  })();

  const hint = phone
    ? bridge.annotator === 'missing'
      ? 'web.review.hint.overlayTouch'
      : 'web.review.hint.touch'
    : bridge.annotator === 'missing'
      ? 'web.review.hint.overlay'
      : 'web.review.hint.annotator';

  const notices = (
    <>
      {!full &&
      !view.follow &&
      shown !== null &&
      current !== null &&
      shown !== current &&
      !versionGone &&
      !grantFailed ? (
        <StagePill action={<ViewLatest href={latestHref} inline />}>
          {t('web.review.olderVersion', { number: shown, latest: current })}
        </StagePill>
      ) : null}
      <LiveBanner pending={view.pending} onSwitch={view.switchNow} />
      {mode === 'comment' ? <StagePill tone="accent">{t(hint)}</StagePill> : null}
    </>
  );

  const panel =
    shown === null ? null : (
      <CommentPanel
        c={c}
        bridge={bridge}
        shown={shown}
        variant={layout}
        liveStatus={liveStatus}
        onAddComment={() => {
          setCommentMode(true);
          setSheetOpen(false);
        }}
        onClose={() => (phone ? setSheetOpen(false) : setPanelPref('closed'))}
        onStep={phone ? undefined : step}
      />
    );

  return (
    <div
      ref={rootRef}
      data-full-screen={full ? fs.mode : undefined}
      className={cn(
        'flex flex-col bg-canvas',
        fs.mode === 'layer'
          ? 'fixed inset-0 z-40 h-dvh'
          : 'h-dvh max-md:h-[calc(100dvh-var(--topbar-height))]',
      )}
    >
      {full ? <ExitFullScreen onExit={fs.exit} /> : null}
      {full ? null : (
        <TopBar
          artifact={artifact}
          phone={phone}
          meId={me.id}
          shown={shown}
          follow={view.follow}
          versions={versions}
          versionList={versionList}
          older={older}
          newer={newer}
          onVersion={goToVersion}
          device={device}
          customWidth={customWidth}
          scale={box.scale}
          onDevice={chooseDevice}
          onCustomWidth={chooseCustomWidth}
          compareHref={compareHref}
          canComment={permissions.canComment}
          commentMode={commentMode}
          onCommentMode={toggleCommentMode}
          commentsOpen={phone ? sheetOpen : panelPref === 'open'}
          openCount={c.query.data === undefined ? null : c.counts.open}
          onComments={toggleComments}
          onFullScreen={enterFullScreen}
          onShortcuts={openShortcuts}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <Stage
          stageRef={stageRef}
          framed={box.framed}
          commenting={mode === 'comment'}
          notices={notices}
        >
          {stageContent}
        </Stage>
        {docked ? (
          <div className="w-(--review-panel-width) max-w-[50%] shrink-0 animate-panel-in">
            {panel}
          </div>
        ) : null}
      </div>
      {phone ? (
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
      <p role="status" className="sr-only">
        {view.announce}
      </p>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

/** A link back to the version the artifact is at now. */
function ViewLatest({ href, inline = false }: { href: string; inline?: boolean }) {
  const { t } = useTranslation();
  if (inline) {
    return (
      <Link
        to={href}
        className="shrink-0 rounded-sm font-medium text-accent-text hover:underline hover:underline-offset-2"
      >
        {t('web.review.viewLatest')}
      </Link>
    );
  }
  return (
    <Button asChild variant="secondary">
      <Link to={href}>{t('web.review.viewLatest')}</Link>
    </Button>
  );
}

/**
 * The way out of full screen, at the top centre. It shows for a moment on
 * entering, whenever the pointer moves (the strip along the top edge catches
 * that over the page, whose frame keeps its own pointer events), and while it
 * has keyboard focus.
 */
function ExitFullScreen({ onExit }: { onExit(): void }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = useCallback(() => {
    setShown(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(false), PILL_MS);
  }, []);
  useEffect(() => {
    reveal();
    window.addEventListener('pointermove', reveal);
    return () => {
      window.removeEventListener('pointermove', reveal);
      clearTimeout(timer.current);
    };
  }, [reveal]);
  return (
    <>
      <div aria-hidden="true" onPointerMove={reveal} className="fixed inset-x-0 top-0 z-50 h-2" />
      <button
        type="button"
        onClick={onExit}
        onPointerEnter={reveal}
        className={cn(
          'fixed top-3 left-1/2 z-50 flex h-9 -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full bg-primary px-4 font-medium text-primary-fg text-sm shadow-popover transition-opacity duration-(--duration-base) focus-visible:opacity-100 [&_svg]:size-4',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <Minimize aria-hidden="true" />
        {t('web.review.exitFullScreen')}
      </button>
    </>
  );
}
