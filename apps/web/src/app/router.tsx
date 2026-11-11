import { createBrowserRouter } from 'react-router';
import { buildRoutes } from './routes.tsx';

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(buildRoutes());
}
