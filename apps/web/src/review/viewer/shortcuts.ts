/** What a key does on the review screen. */
export type ReviewAction =
  | 'commentMode'
  | 'togglePanel'
  | 'nextThread'
  | 'prevThread'
  | 'prevVersion'
  | 'nextVersion'
  | 'desktop'
  | 'tablet'
  | 'phone'
  | 'fullScreen'
  | 'shortcuts'
  | 'escape';

/**
 * The review screen's shortcuts, in the order the shortcuts dialog lists
 * them. This one list drives both the key handler and the dialog. `label` is
 * the i18n key of the action's name, which is also the accessible name of the
 * control that does the same: a key pressed while the page in the frame has
 * focus never reaches the app, so every action except Escape is a click away
 * too.
 */
export const REVIEW_SHORTCUTS: readonly { action: ReviewAction; keys: string[]; label: string }[] =
  [
    { action: 'commentMode', keys: ['c'], label: 'web.review.commentMode' },
    { action: 'togglePanel', keys: ['shift', 'c'], label: 'web.review.comments' },
    { action: 'nextThread', keys: ['j'], label: 'web.comments.next' },
    { action: 'prevThread', keys: ['k'], label: 'web.comments.previous' },
    { action: 'prevVersion', keys: ['['], label: 'web.review.olderVersionAction' },
    { action: 'nextVersion', keys: [']'], label: 'web.review.newerVersionAction' },
    { action: 'desktop', keys: ['1'], label: 'web.review.device.desktop' },
    { action: 'tablet', keys: ['2'], label: 'web.review.device.tablet' },
    { action: 'phone', keys: ['3'], label: 'web.review.device.phone' },
    { action: 'fullScreen', keys: ['f'], label: 'web.review.fullScreen' },
    { action: 'shortcuts', keys: ['?'], label: 'web.shortcuts.title' },
    { action: 'escape', keys: ['escape'], label: 'web.shortcuts.escape' },
  ];

/** The keys of `action`. */
export function keysOf(action: ReviewAction): string[] {
  return REVIEW_SHORTCUTS.find((s) => s.action === action)?.keys ?? [];
}
