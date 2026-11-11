import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.ts';
import { IconButton } from './icon-button.tsx';
import { CONTROL_CLASS, TEXT_ENTRY_CLASS } from './input.tsx';
import { formatShortcut } from './kbd.tsx';

/**
 * Copies text to the clipboard. Uses the Clipboard API when the page may (https
 * or localhost); otherwise selects a hidden textarea and runs the legacy copy
 * command, which also works on plain-http installs. Resolves false when neither
 * worked, so the caller can ask the person to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or not focused: fall through to the legacy path.
    }
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Insert next to the focused element: a dialog's focus trap would pull focus
  // back out of a textarea appended to <body>, and the copy would be empty.
  const host = previous?.parentElement ?? document.body;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  host.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
  return copied;
}

type CopyStatus = 'idle' | 'copied' | 'manual';
const COPIED_MS = 2000;

/**
 * Read-only text with a Copy button inside its right edge. A successful copy
 * swaps the icon to a check and announces "Copied"; when the browser refuses,
 * the text is selected and the person is told which keys copy it.
 */
export function CopyField({
  label,
  value,
  multiline = false,
  mono = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const statusId = `${id}-status`;
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [copiedAt, setCopiedAt] = useState(0);

  useEffect(() => {
    if (copiedAt === 0) return;
    const timer = window.setTimeout(() => setStatus('idle'), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copiedAt]);

  async function copy() {
    if (await copyText(value)) {
      setStatus('copied');
      setCopiedAt(Date.now());
      return;
    }
    field.current?.focus();
    field.current?.select();
    setStatus('manual');
  }

  const fieldProps = {
    id,
    ref: field,
    readOnly: true,
    value,
    spellCheck: false,
    'aria-describedby': status === 'manual' ? statusId : undefined,
    onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
      event.currentTarget.select(),
    className: cn(
      CONTROL_CLASS,
      TEXT_ENTRY_CLASS,
      'pr-11',
      mono ? 'font-mono text-sm' : null,
      multiline ? 'resize-none whitespace-pre py-2' : 'h-9 truncate',
    ),
  };
  const rows = Math.min(Math.max(value.split('\n').length, 2), 12);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-fg text-sm">
        {label}
      </label>
      <div className="relative">
        {multiline ? (
          <textarea {...fieldProps} rows={rows} wrap="off" />
        ) : (
          <input {...fieldProps} />
        )}
        <div className="absolute top-0.5 right-0.5">
          <IconButton
            label={t('web.common.copy')}
            icon={status === 'copied' ? <Check className="text-success" /> : <Copy />}
            size="sm"
            onClick={() => void copy()}
          />
        </div>
      </div>
      <p
        id={statusId}
        role="status"
        className={status === 'manual' ? 'text-fg-muted text-sm' : 'sr-only'}
      >
        {status === 'copied' ? t('web.common.copied') : null}
        {status === 'manual'
          ? t('web.common.copyManually', { keys: formatShortcut(['mod', 'c']) })
          : null}
      </p>
    </div>
  );
}
