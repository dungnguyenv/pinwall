import { Archive } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n.ts';
import {
  collectFromDataTransfer,
  UploadReadError,
  type UploadSelection,
} from '../../lib/upload/collect.ts';
import { cn, PinMark } from '../../ui/index.ts';
import { toastUploadFailure } from './upload-toast.tsx';

/**
 * Reads a drop into a selection, telling the person when part of it could
 * not be read rather than uploading the rest.
 */
export function readDrop(dt: DataTransfer, onSelection: (s: UploadSelection) => void): void {
  collectFromDataTransfer(dt).then(
    (selection) => {
      if (selection) onSelection(selection);
    },
    (error: unknown) => {
      if (error instanceof UploadReadError) {
        const top = error.path.split('/', 1)[0] ?? error.path;
        toastUploadFailure(top, i18n.t('web.upload.readFailed', { path: error.path }));
      } else {
        toastUploadFailure('', i18n.t('web.error.generic'));
      }
    },
  );
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Covers the window while files are dragged over it and publishes what is
 * dropped anywhere on it. Drags of text, links or the page's own images are
 * left alone. When `disabled` it says why nothing can be dropped (by default
 * that the project is archived; `reason` says otherwise), and a drop does
 * nothing, not even the browser opening the file.
 */
export function DropOverlay({
  label,
  disabled = false,
  reason,
  onSelection,
}: {
  label: string;
  disabled?: boolean;
  reason?: string;
  onSelection(s: UploadSelection): void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const latest = useRef({ disabled, onSelection });
  useLayoutEffect(() => {
    latest.current = { disabled, onSelection };
  });

  useEffect(() => {
    // dragenter and dragleave come in pairs for every element the pointer crosses; the
    // overlay is up while more have been entered than left.
    let depth = 0;
    // A drag that started on this page (an image, a link) is not an upload.
    let fromPage = false;
    const isUpload = (event: DragEvent) => !fromPage && carriesFiles(event);
    const reset = () => {
      depth = 0;
      setOver(false);
    };

    const onDragStart = () => {
      fromPage = true;
    };
    const onDragEnd = () => {
      fromPage = false;
      reset();
    };
    const onDragEnter = (event: DragEvent) => {
      if (!isUpload(event)) return;
      event.preventDefault();
      depth += 1;
      setOver(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!isUpload(event)) return;
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = latest.current.disabled ? 'none' : 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!isUpload(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!isUpload(event)) return;
      reset();
      // A drop zone on the page (the upload dialog's) already took it.
      if (event.defaultPrevented) return;
      event.preventDefault();
      const { disabled: refused, onSelection: take } = latest.current;
      if (refused || !event.dataTransfer) return;
      // Synchronously, before this handler returns: the browser empties the items after it.
      readDrop(event.dataTransfer, take);
    };

    const listeners = [
      ['dragstart', onDragStart],
      ['dragend', onDragEnd],
      ['dragenter', onDragEnter],
      ['dragover', onDragOver],
      ['dragleave', onDragLeave],
      ['drop', onDrop],
    ] as const;
    for (const [type, listener] of listeners) window.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    };
  }, []);

  if (!over) return null;
  // In the body, above dialogs, and able to take the drop even while a dialog
  // has made the rest of the page inert to the pointer.
  return createPortal(
    <div className="pointer-events-auto fixed inset-0 z-60 animate-fade-in bg-canvas/80 p-3 backdrop-blur-[2px] md:p-5">
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 text-center',
          disabled ? 'border-border-strong bg-surface-muted' : 'border-accent bg-accent-soft/70',
        )}
      >
        {disabled ? (
          <Archive aria-hidden="true" className="size-8 text-fg-muted" />
        ) : (
          <PinMark size={52} className="mb-1 animate-pin-drop" />
        )}
        <p className="max-w-md text-balance font-semibold text-fg text-xl [overflow-wrap:anywhere]">
          {disabled
            ? (reason ?? t('web.upload.archived'))
            : t('web.upload.dropHere', { project: label })}
        </p>
        {disabled ? null : <p className="text-base text-fg-muted">{t('web.upload.hint')}</p>}
      </div>
    </div>,
    document.body,
  );
}
