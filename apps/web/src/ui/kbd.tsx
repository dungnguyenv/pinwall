interface NavigatorWithUAData extends Navigator {
  userAgentData?: { platform?: string };
}

/** True on macOS and iOS, where shortcuts use ⌘ instead of Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// Key names are lower-case words ('mod', 'shift', 'enter') or a single character.
const APPLE_LABELS: Record<string, string> = {
  mod: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space',
};

const OTHER_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  meta: 'Win',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  enter: '↵',
  escape: 'Esc',
  backspace: 'Backspace',
  tab: 'Tab',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space',
};

// Names from the WAI-ARIA aria-keyshortcuts grammar (UI Events `key` values).
const ARIA_NAMES: Record<string, string> = {
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  escape: 'Escape',
  backspace: 'Backspace',
  tab: 'Tab',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  space: 'Space',
};

function keyLabel(key: string, apple: boolean): string {
  const name = key.toLowerCase();
  return (apple ? APPLE_LABELS : OTHER_LABELS)[name] ?? key.toUpperCase();
}

/** The labels a person sees for a shortcut, one per key: ['⌘', 'K'] or ['Ctrl', 'K']. */
export function shortcutLabels(keys: string[]): string[] {
  const apple = isApplePlatform();
  return keys.map((key) => keyLabel(key, apple));
}

/** A shortcut as one string: '⌘K' on Apple platforms, 'Ctrl+K' elsewhere. */
export function formatShortcut(keys: string[]): string {
  return shortcutLabels(keys).join(isApplePlatform() ? '' : '+');
}

/** A shortcut in aria-keyshortcuts form, for example 'Meta+K' or 'Control+K'. */
export function ariaKeyShortcuts(keys: string[]): string {
  const apple = isApplePlatform();
  return keys
    .map((key) => {
      const name = key.toLowerCase();
      if (name === 'mod') return apple ? 'Meta' : 'Control';
      if (name === 'meta') return 'Meta';
      return ARIA_NAMES[name] ?? key.toUpperCase();
    })
    .join('+');
}

/** Keys of a shortcut, each in its own cap. 'mod' shows ⌘ on Apple platforms and Ctrl elsewhere. */
export function Kbd({ keys }: { keys: string[] }) {
  return (
    <kbd className="inline-flex items-center gap-0.5 font-sans">
      {shortcutLabels(keys).map((label, index) => (
        <kbd
          // Keys may repeat ('g g'), so the position is part of the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: labels are static and may repeat
          key={index}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-surface-muted px-1 font-medium text-fg-muted text-xs"
        >
          {label}
        </kbd>
      ))}
    </kbd>
  );
}
