import { CircleAlert } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { cn } from '../../ui/cn.ts';

/** ⌘↵ or Ctrl+↵: sends what a comment box holds. */
export function isSendKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/**
 * The text a comment points at on the page, cut to two lines. The accent rule
 * echoes the highlight the page draws around the same words.
 */
export function QuoteText({ text, className }: { text: string; className?: string }) {
  return (
    <blockquote
      className={cn(
        'line-clamp-2 border-accent border-l-2 pl-2 text-fg-muted text-sm [overflow-wrap:anywhere]',
        className,
      )}
    >
      {text}
    </blockquote>
  );
}

/** Why sending a comment failed, as the server put it. */
export function SendError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-danger text-sm">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="[overflow-wrap:anywhere]">{message}</span>
    </p>
  );
}
