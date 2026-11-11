import type { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { HttpHandler, HttpResponse, http } from 'msw';
import { createMemoryRouter, type RouteObject } from 'react-router';
import { App } from '../App.tsx';
import type { Me, PublicConfig } from '../api/dto.ts';
import { createQueryClient } from '../api/query-client.ts';
import { buildRoutes } from '../app/routes.tsx';
import { fx } from './fixtures.ts';
import { API, apiError, server } from './server.ts';

export { setViewport } from './viewport.ts';

export interface RenderRouteOptions {
  /** The signed-in user; `null` for a signed-out visitor. Default `fx.me()`. */
  me?: Me | null;
  /** Overrides for `fx.config()`, served at `GET /config/public`. */
  config?: Partial<PublicConfig>;
  /** The route tree; default `buildRoutes()`. Tests add probe routes in front of it. */
  routes?: RouteObject[];
}

/** The handlers `renderRoute` registered itself, so a second call in a test can replace them. */
const ownHandlers = new WeakSet<object>();

/** Whether the test itself registered a GET handler for `path`, which then wins. */
function testHandles(path: string): boolean {
  return server
    .listHandlers()
    .some(
      (handler) =>
        handler instanceof HttpHandler &&
        !ownHandlers.has(handler) &&
        handler.info.method === 'GET' &&
        handler.info.path === path,
    );
}

/**
 * Renders the app at `path` in a memory router, with fresh query state.
 * Serves `GET /me` and `GET /config/public` from the options, unless the test
 * registered its own handler for one of them before calling this. Queries do
 * not retry here, so error states show at once.
 */
export function renderRoute(
  path: string,
  o: RenderRouteOptions = {},
): { user: UserEvent; router: ReturnType<typeof createMemoryRouter>; queryClient: QueryClient } {
  const me = o.me === undefined ? fx.me() : o.me;
  const config = fx.config(o.config);
  const defaults = [
    testHandles(`${API}/me`)
      ? null
      : http.get(`${API}/me`, () =>
          me ? HttpResponse.json(me) : apiError(401, 'unauthorized', 'Sign in to continue.'),
        ),
    testHandles(`${API}/config/public`)
      ? null
      : http.get(`${API}/config/public`, () => HttpResponse.json(config)),
  ].filter((handler) => handler !== null);
  for (const handler of defaults) ownHandlers.add(handler);
  if (defaults.length > 0) server.use(...defaults);

  const queryClient = createQueryClient();
  const defaultOptions = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaultOptions,
    queries: { ...defaultOptions.queries, retry: false },
  });

  const router = createMemoryRouter(o.routes ?? buildRoutes(), { initialEntries: [path] });
  const user = userEvent.setup();
  render(<App router={router} queryClient={queryClient} />);
  return { user, router, queryClient };
}
