import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactElement, useEffect } from 'react';
import type { DataRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { setUnauthorizedHandler } from './api/client.ts';
import { replaceSession } from './api/session.ts';
import { Toaster, TooltipProvider } from './ui/index.ts';

/**
 * The app's providers around its router. A 401 `unauthorized` from any
 * request marks the session gone (`me` = null) and forgets the data cached
 * for it; `RequireAuth` then sends the person to sign in and back to the page
 * they were on. The removed queries' observers are not told, so the
 * signed-in pages do not refetch before `RequireAuth` replaces them.
 */
export function App({
  router,
  queryClient,
}: {
  router: DataRouter;
  queryClient: QueryClient;
}): ReactElement {
  useEffect(() => {
    setUnauthorizedHandler(() => replaceSession(queryClient, null));
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
