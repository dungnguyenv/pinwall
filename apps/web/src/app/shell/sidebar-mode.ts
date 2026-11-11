import { createContext, useCallback, useContext, useMemo } from 'react';
import { usePref } from '../../lib/storage.ts';

/** The wide-screen sidebar: the full column, or the icon rail. */
export type SidebarMode = 'open' | 'rail';

const MODES: readonly SidebarMode[] = ['open', 'rail'];

export interface SidebarModeState {
  mode: SidebarMode;
  /**
   * The review screen (`/a/*`) needs the room, so it always shows the rail.
   * The saved choice is neither used nor changed there.
   */
  forcedRail: boolean;
  /**
   * Switches between the full sidebar and the rail, and saves the choice for
   * this person. Where the rail is forced, it opens the full sidebar over the
   * page instead.
   */
  toggle(): void;
}

/** Each person who signs in on this browser keeps their own choice. */
export function sidebarPrefKey(userId: string): string {
  return `pinwall:sidebar:${userId}`;
}

export function isReviewPath(pathname: string): boolean {
  return pathname.startsWith('/a/');
}

/**
 * The sidebar state for `pathname`. AppShell calls this once and shares the
 * result through `SidebarModeContext`; everything else reads it with
 * `useSidebarMode()`.
 */
export function useSidebarModeState(
  userId: string | null,
  pathname: string,
  showOverPage: () => void,
): SidebarModeState {
  const key = userId === null ? null : sidebarPrefKey(userId);
  const [saved, setSaved] = usePref(key, MODES, 'open');
  const forcedRail = isReviewPath(pathname);

  const toggle = useCallback(() => {
    if (forcedRail) showOverPage();
    else setSaved(saved === 'open' ? 'rail' : 'open');
  }, [forcedRail, saved, setSaved, showOverPage]);

  return useMemo(
    () => ({ mode: forcedRail ? 'rail' : saved, forcedRail, toggle }),
    [forcedRail, saved, toggle],
  );
}

export const SidebarModeContext = createContext<SidebarModeState | null>(null);

export function useSidebarMode(): SidebarModeState {
  const state = useContext(SidebarModeContext);
  if (!state) throw new Error('useSidebarMode() needs AppShell around it');
  return state;
}
