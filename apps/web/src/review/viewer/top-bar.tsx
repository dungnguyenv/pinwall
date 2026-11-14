import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { ChevronRight, GitCompareArrows, Share } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import type { ApiError } from '../../api/client.ts';
import type { ArtifactSummary, VersionList, VersionSummary } from '../../api/dto.ts';
import { useProject } from '../../api/library.ts';
import { claimHeadingFocus, HeadingFocusContext } from '../../app/shell/page-header.tsx';
import { Button, MenuItem, Skeleton } from '../../ui/index.ts';
import type { Device } from '../frame/device.ts';
import { ShareDialog } from '../share/share-dialog.tsx';
import { CommentModeToggle, CommentsToggle } from './comment-toggles.tsx';
import { DevicePicker } from './device-picker.tsx';
import { ReviewMenu } from './review-menu.tsx';
import { VersionSwitcher } from './version-switcher.tsx';

export interface TopBarProps {
  artifact: ArtifactSummary;
  phone: boolean;
  meId: string;
  /** The version shown; null while none is. */
  shown: number | null;
  /** The version shown as the server describes it; null while it is not known, or none is shown. */
  shownVersion: VersionSummary | null;
  /** Whether the review follows the latest version rather than one chosen in the address. */
  follow: boolean;
  versions: UseInfiniteQueryResult<InfiniteData<VersionList>, ApiError>;
  versionList: VersionSummary[];
  older: number | null;
  newer: number | null;
  onVersion(n: number): void;
  device: Device;
  customWidth: number;
  scale: number;
  onDevice(d: Device): void;
  onCustomWidth(width: number): void;
  compareHref: string;
  canComment: boolean;
  commentMode: boolean;
  onCommentMode(): void;
  /** Whether the comments are showing: the docked panel, or the sheet on a phone. */
  commentsOpen: boolean;
  /** Open threads on the version shown; null until they are read. */
  openCount: number | null;
  onComments(): void;
  onFullScreen(): void;
  onShortcuts(): void;
}

/**
 * The project as a link, then the artifact's name as the page's heading. The
 * heading takes focus when the review screen is navigated to, as every page's
 * does; moving between versions leaves focus where it is.
 */
function Breadcrumb({ artifact, phone }: { artifact: ArtifactSummary; phone: boolean }) {
  const { t } = useTranslation();
  const project = useProject(artifact.project_id);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useContext(HeadingFocusContext);
  const { pathname } = useLocation();
  const mounted = useRef(false);

  useEffect(() => {
    if (claimHeadingFocus(pending, pathname) && !mounted.current) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [pending, pathname]);
  useEffect(() => {
    mounted.current = true;
  }, []);

  return (
    <nav aria-label={t('web.artifact.breadcrumb')} className="flex min-w-0 shrink items-center">
      {phone ? null : (
        <>
          {project.data ? (
            <Link
              to={`/projects/${encodeURIComponent(project.data.id)}`}
              className="min-w-0 max-w-48 shrink-[3] truncate rounded-sm text-fg-muted text-sm hover:text-fg hover:underline hover:underline-offset-2"
            >
              {project.data.name}
            </Link>
          ) : project.isError ? null : (
            <Skeleton className="h-3.5 w-20" />
          )}
          <ChevronRight aria-hidden="true" className="mx-1 size-3.5 shrink-0 text-fg-subtle" />
        </>
      )}
      <h1
        ref={heading}
        tabIndex={-1}
        title={artifact.name}
        className="min-w-0 truncate font-semibold text-fg text-md outline-none"
      >
        {artifact.name}
      </h1>
    </nav>
  );
}

/**
 * The review screen's slim bar. Left: where the artifact lives and its name,
 * then the version. Right: screen sizes, Compare, comment mode, comments,
 * Share and More actions. On a phone it keeps the name, the version, comment
 * mode, comments and the menu, which takes Compare and Share.
 */
export function TopBar(p: TopBarProps) {
  const { t } = useTranslation();
  const [sharing, setSharing] = useState(false);
  // The versions read so far; a next page means there are more than the first page holds.
  const versionCount = p.versions.hasNextPage
    ? Math.max(p.versionList.length, 2)
    : p.versionList.length;
  return (
    <header className="flex h-(--topbar-height) shrink-0 items-center gap-1 border-border border-b bg-canvas px-2 md:gap-1.5 md:px-3">
      <Breadcrumb artifact={p.artifact} phone={p.phone} />
      {p.shown === null ? null : (
        <VersionSwitcher
          shown={p.shown}
          versions={p.versions}
          list={p.versionList}
          meId={p.meId}
          older={p.older}
          newer={p.newer}
          onChoose={p.onVersion}
        />
      )}
      <div className="min-w-2 flex-1" />
      {p.phone ? null : (
        <DevicePicker
          device={p.device}
          customWidth={p.customWidth}
          scale={p.scale}
          onDevice={p.onDevice}
          onCustomWidth={p.onCustomWidth}
        />
      )}
      {p.phone ? null : (
        <Button
          asChild
          variant="ghost"
          size="sm"
          leadingIcon={<GitCompareArrows />}
          className="px-2.5 text-fg-muted hover:text-fg lg:px-3"
        >
          <Link to={p.compareHref}>
            <span className="max-lg:sr-only">{t('web.review.compare')}</span>
          </Link>
        </Button>
      )}
      {p.canComment ? <CommentModeToggle on={p.commentMode} onToggle={p.onCommentMode} /> : null}
      <CommentsToggle open={p.commentsOpen} count={p.openCount} onToggle={p.onComments} />
      {p.phone ? null : (
        <Button
          size="sm"
          leadingIcon={<Share />}
          className="ml-0.5"
          disabled={p.shown === null}
          onClick={() => setSharing(true)}
        >
          {t('web.review.share')}
        </Button>
      )}
      <ReviewMenu
        artifact={p.artifact}
        shown={p.shown}
        shownVersion={p.shownVersion}
        follow={p.follow}
        versionCount={versionCount}
        onFullScreen={p.onFullScreen}
        onShortcuts={p.onShortcuts}
        extra={
          p.phone ? (
            <>
              <MenuItem asChild icon={<GitCompareArrows />}>
                <Link to={p.compareHref}>{t('web.review.compare')}</Link>
              </MenuItem>
              <MenuItem
                icon={<Share />}
                disabled={p.shown === null}
                onSelect={() => setSharing(true)}
              >
                {t('web.review.share')}
              </MenuItem>
            </>
          ) : undefined
        }
      />
      <ShareDialog
        open={sharing}
        onOpenChange={setSharing}
        artifact={p.artifact}
        shown={p.shownVersion}
      />
    </header>
  );
}
