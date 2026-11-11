import { Tooltip as RadixTooltip } from 'radix-ui';
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';

const DELAY_MS = 300;

// Lets a Tooltip rendered outside the app's provider (an isolated test, a
// portal) create its own provider instead of throwing.
const ProviderPresent = createContext(false);

/** Shares the open delay across tooltips, so moving between them is instant. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <ProviderPresent.Provider value={true}>
      <RadixTooltip.Provider delayDuration={DELAY_MS}>{children}</RadixTooltip.Provider>
    </ProviderPresent.Provider>
  );
}

/**
 * A short label shown on hover (after 300 ms) and at once on keyboard focus.
 * `children` must be one element that accepts a ref and DOM event props.
 */
export function Tooltip({
  content,
  side = 'top',
  children,
}: {
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement;
}) {
  const hasProvider = useContext(ProviderPresent);
  const tooltip = (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex max-w-60 origin-(--radix-tooltip-content-transform-origin) items-center gap-2 rounded-md bg-primary px-2 py-1 font-medium text-primary-fg text-xs shadow-popover data-[state=closed]:animate-pop-out data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-pop-in [&_kbd_kbd]:border-primary-fg/25 [&_kbd_kbd]:bg-transparent [&_kbd_kbd]:text-primary-fg/80"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
  return hasProvider ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}
