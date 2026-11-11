import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export const Tabs = RadixTabs.Root;

/** A row of tabs on a hairline; give it an aria-label that names the set. */
export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn(
        'flex items-center gap-5 overflow-x-auto border-border border-b [scrollbar-width:none]',
        className,
      )}
      {...props}
    />
  );
}

/** The active tab is marked by full-strength text and a 2px bar on the hairline. */
export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'relative inline-flex h-10 shrink-0 cursor-pointer select-none items-center gap-2 rounded-sm font-medium text-base text-fg-muted transition-colors hover:text-fg data-disabled:cursor-not-allowed data-[state=active]:text-fg data-disabled:opacity-50 [&_svg]:size-4',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-fg after:opacity-0 after:transition-opacity data-[state=active]:after:opacity-100',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content
      className={cn('rounded-md pt-5 focus-visible:outline-offset-4', className)}
      {...props}
    />
  );
}
