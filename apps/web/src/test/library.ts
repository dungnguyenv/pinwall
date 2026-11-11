import { HttpResponse, http } from 'msw';
import type { ArtifactSummary, Project } from '../api/dto.ts';
import { fx } from './fixtures.ts';
import { API, server } from './server.ts';

/** Epoch milliseconds `hours` before now. */
export function hoursAgo(hours: number): number {
  return Date.now() - hours * 3_600_000;
}

/**
 * Serves what the sidebar asks for on every signed-in page: the active
 * projects (`projects`, default none), no archived ones, and `recent`.
 */
export function serveSidebar(o: { projects?: Project[]; recent?: ArtifactSummary[] } = {}): void {
  server.use(
    http.get(`${API}/projects`, ({ request }) => {
      const archived = new URL(request.url).searchParams.get('archived') === 'true';
      return HttpResponse.json(fx.page(archived ? [] : (o.projects ?? [])));
    }),
    http.get(`${API}/artifacts/recent`, () => HttpResponse.json(fx.page(o.recent ?? []))),
  );
}

/**
 * Serves `GET /artifacts` from `respond` and records the query string of each
 * request, e.g. `?project_id=prj_1&limit=48`.
 */
export function serveArtifacts(
  respond: (params: URLSearchParams) => Response | Promise<Response>,
): string[] {
  const requests: string[] = [];
  server.use(
    http.get(`${API}/artifacts`, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url.search);
      return respond(url.searchParams);
    }),
  );
  return requests;
}

/**
 * The name of an artifact's card or row link: the artifact's name, then the
 * version, time and signals that the link also shows.
 */
export function artifactLink(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);
}
