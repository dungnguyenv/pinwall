import { Files, FolderOpen, Upload } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicConfig } from '../../api/session.ts';
import { formatBytes } from '../../lib/format.ts';
import { Button, cn, Dialog, Tooltip } from '../../ui/index.ts';
import { readDrop } from './drop-overlay.tsx';
import type { UploadControls } from './use-upload.tsx';

const count = new Intl.NumberFormat('en');

/**
 * The Upload button of a library page. When uploading is not possible its
 * tooltip says why; the button itself takes no pointer events then, so the
 * tooltip opens over it.
 */
export function UploadButton({
  label,
  variant,
  disabledReason,
  onClick,
}: {
  label: string;
  variant: 'primary' | 'secondary';
  disabledReason?: string | null;
  onClick(): void;
}) {
  const button = (
    <Button
      variant={variant}
      leadingIcon={<Upload />}
      disabled={Boolean(disabledReason)}
      onClick={onClick}
      className={disabledReason ? 'pointer-events-none' : undefined}
    >
      {label}
    </Button>
  );
  if (!disabledReason) return button;
  return (
    <Tooltip content={disabledReason}>
      <span className="inline-flex cursor-not-allowed rounded-full">{button}</span>
    </Tooltip>
  );
}

/**
 * Upload by choosing: files or one archive, or a folder, with a drop zone for
 * people who opened it before dragging. It closes as soon as a selection
 * starts, picked or dropped, leaving the toast to follow the upload.
 */
export function UploadDialog({
  open,
  onOpenChange,
  upload,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  upload: UploadControls;
}) {
  const { t } = useTranslation();
  const limits = usePublicConfig().data?.limits;
  const [over, setOver] = useState(false);

  const seen = useRef(upload.started);
  useEffect(() => {
    if (upload.started === seen.current) return;
    seen.current = upload.started;
    if (open) onOpenChange(false);
  }, [upload.started, open, onOpenChange]);

  const allowDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setOver(true);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOver(false);
        onOpenChange(next);
      }}
      title={t('web.upload.title', { project: upload.projectName })}
      description={t('web.upload.hint')}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragged files; the buttons inside are how a keyboard chooses them */}
      <div
        onDragEnter={allowDrop}
        onDragOver={allowDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setOver(false);
          readDrop(event.dataTransfer, upload.start);
        }}
        className={cn(
          'flex flex-col items-center gap-4 rounded-lg border-2 border-dashed px-5 py-8 text-center transition-colors max-sm:py-6',
          over ? 'border-accent bg-accent-soft' : 'border-border-strong',
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            'grid size-11 place-items-center rounded-full transition-colors [&_svg]:size-5',
            over ? 'bg-surface text-accent-text' : 'bg-surface-muted text-fg-muted',
          )}
        >
          <Upload />
        </div>
        <p className="text-base text-fg">{t('web.upload.dragHere')}</p>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button leadingIcon={<Files />} onClick={() => upload.pick('files')}>
            {t('web.upload.chooseFiles')}
          </Button>
          <Button
            variant="secondary"
            leadingIcon={<FolderOpen />}
            onClick={() => upload.pick('folder')}
          >
            {t('web.upload.chooseFolder')}
          </Button>
        </div>
      </div>
      {limits ? (
        <p className="mt-3 text-center text-fg-muted text-sm">
          {t('web.upload.limits', {
            size: formatBytes(limits.max_upload_bytes),
            count: count.format(limits.max_files),
          })}
        </p>
      ) : null}
    </Dialog>
  );
}
