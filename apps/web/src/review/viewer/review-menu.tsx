import { useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Ellipsis,
  ExternalLink,
  Keyboard,
  Link2,
  Maximize,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import type { ArtifactSummary, Me } from '../../api/dto.ts';
import { useMe } from '../../api/session.ts';
import { rawPath, refreshVersions, restoreVersion, reviewPath } from '../../api/versions.ts';
import { useGoTo } from '../../lib/navigation.ts';
import {
  copyText,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  toast,
} from '../../ui/index.ts';
import { DeleteArtifactDialog, DeleteVersionDialog } from './delete-dialogs.tsx';
import { keysOf } from './shortcuts.ts';

/** Whether `me` may delete the artifact or any of its versions, as the server decides: an admin or its publisher. */
export function canDelete(me: Me, artifact: { created_by: string | null }): boolean {
  return me.role === 'admin' || artifact.created_by === me.id;
}

export interface ReviewMenuProps {
  artifact: ArtifactSummary;
  /** The version on screen; null when the artifact has none. */
  shown: number | null;
  /** Whether the review follows the latest version (`/a/:id`) rather than showing the one in its address. */
  follow: boolean;
  /** How many versions the artifact has, as far as is known: 0 until its list is read. */
  versionCount: number;
  onFullScreen(): void;
  onShortcuts(): void;
  /** Items for the phone layout, whose bar has no room for them: Compare and Share. */
  extra?: ReactNode;
}

/**
 * More actions on the review screen: the page's links, full screen, the
 * keyboard shortcuts, and the version actions: restore the version on screen
 * as the current one, delete it, or delete the artifact. Deleting asks first,
 * with the warning about backups; the server decides who may.
 */
export function ReviewMenu(p: ReviewMenuProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const goTo = useGoTo();
  const me = useMe().data;
  const { artifact, shown } = p;
  const [restoring, setRestoring] = useState(false);
  // The version a deletion asks about stays as it was when the menu item was chosen,
  // even if the review moves on while the dialog is open.
  const [deletingVersion, setDeletingVersion] = useState<{ number: number; open: boolean } | null>(
    null,
  );
  const [deletingArtifact, setDeletingArtifact] = useState(false);

  // Raw and review links name the version in the address, or the latest one when following.
  const pinned = p.follow ? null : shown;
  const reviewHref = reviewPath(artifact.id, pinned);
  const rawHref = rawPath(artifact.id, pinned);

  const current = artifact.current_version;
  const mayRestore = shown !== null && current !== null && shown !== current.number;
  const mayDelete = me != null && canDelete(me, artifact);
  const mayDeleteVersion = mayDelete && shown !== null && p.versionCount > 1;

  async function copyLink(path: string) {
    if (await copyText(window.location.origin + path)) toast.success(t('web.comments.linkCopied'));
    else toast.error(t('web.comments.copyFailed'));
  }

  /** Copies version `shown` over the current one, as a new version on top; then shows it. */
  async function restore() {
    if (restoring || shown === null || current === null) return;
    setRestoring(true);
    try {
      const restored = await restoreVersion(artifact.id, shown, current.id);
      await refreshVersions(queryClient, artifact.id);
      goTo(reviewPath(artifact.id));
      toast.success(t('web.review.restored', { number: shown, as: restored.number }));
    } catch (caught) {
      toast.error(errorMessage(caught, t));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            label={t('web.review.more')}
            icon={<Ellipsis />}
            size="sm"
            tooltipSide="bottom"
          />
        </MenuTrigger>
        <MenuContent align="end">
          {shown === null ? null : (
            <>
              <MenuItem asChild icon={<ExternalLink />}>
                <a href={rawHref} target="_blank" rel="noopener noreferrer">
                  {t('web.review.openRaw')}
                </a>
              </MenuItem>
              <MenuItem icon={<Link2 />} onSelect={() => void copyLink(reviewHref)}>
                {t('web.review.copyReviewLink')}
              </MenuItem>
              <MenuItem icon={<Copy />} onSelect={() => void copyLink(rawHref)}>
                {t('web.review.copyRawLink')}
              </MenuItem>
            </>
          )}
          {p.extra}
          <MenuItem icon={<Maximize />} shortcut={keysOf('fullScreen')} onSelect={p.onFullScreen}>
            {t('web.review.fullScreen')}
          </MenuItem>
          <MenuItem icon={<Keyboard />} shortcut={keysOf('shortcuts')} onSelect={p.onShortcuts}>
            {t('web.shortcuts.title')}
          </MenuItem>
          {mayRestore || mayDelete ? <MenuSeparator /> : null}
          {mayRestore ? (
            <MenuItem icon={<RotateCcw />} disabled={restoring} onSelect={() => void restore()}>
              {t('web.review.restore', { number: shown })}
            </MenuItem>
          ) : null}
          {mayDeleteVersion ? (
            <MenuItem
              icon={<Trash2 />}
              onSelect={() => setDeletingVersion({ number: shown, open: true })}
            >
              {t('web.review.deleteVersion.item', { number: shown })}
            </MenuItem>
          ) : null}
          {mayDelete ? (
            <MenuItem tone="danger" icon={<Trash2 />} onSelect={() => setDeletingArtifact(true)}>
              {t('web.review.deleteArtifact.item')}
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
      {deletingVersion ? (
        <DeleteVersionDialog
          artifact={artifact}
          number={deletingVersion.number}
          open={deletingVersion.open}
          onOpenChange={(open) => setDeletingVersion((now) => (now ? { ...now, open } : now))}
        />
      ) : null}
      {mayDelete ? (
        <DeleteArtifactDialog
          artifact={artifact}
          open={deletingArtifact}
          onOpenChange={setDeletingArtifact}
        />
      ) : null}
    </>
  );
}
