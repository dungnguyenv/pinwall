import { createContext, useContext } from 'react';

/**
 * What any part of the shell can ask for. AppShell owns the dialogs and the
 * drawer, so they stay open while the sidebar that asked for them changes
 * shape or closes.
 */
export interface ShellActions {
  openSearch(): void;
  openNewProject(): void;
  /** Shows the full sidebar over the page: the phone drawer, or on the review screen. */
  openDrawer(): void;
}

export const ShellActionsContext = createContext<ShellActions | null>(null);

export function useShellActions(): ShellActions {
  const actions = useContext(ShellActionsContext);
  if (!actions) throw new Error('useShellActions() needs AppShell around it');
  return actions;
}
