import type { Anchor } from '@pinwall/shared/protocol';
import { HttpResponse, http } from 'msw';
import { onTestFinished } from 'vitest';
import type { ArtifactSummary, CommentThread, VersionSummary } from '../api/dto.ts';
import { fx } from './fixtures.ts';
import { hoursAgo, serveSidebar } from './library.ts';
import { API, apiError, server } from './server.ts';

/** The signed-in reviewer of the review screen tests. */
export const reviewer = fx.me({ id: 'usr_1', name: 'Ada', role: 'member' });
export const launchSite = fx.project({ id: 'prj_2', name: 'Launch site' });

/** The URL of version `n`'s review grant. */
export const grantUrl = (n: number) => `https://content.example/g/v${n}/`;

/** A point anchor on the entry page. */
export function pointAt(x: number, y: number): Anchor {
  return { page: '', kind: 'point', position: { x, y }, viewport: { width: 1280 } };
}

/** A text anchor on the entry page. */
export function quoteOf(exact: string): Anchor {
  return {
    page: '',
    kind: 'text',
    quote: { exact, prefix: 'Our ', suffix: ' plans' },
    position: { x: 0.2, y: 0.1 },
    viewport: { width: 1280 },
  };
}

/** An open thread by the reviewer on version `n`, pinned to a point of the entry page. */
export function threadOn(n: number, o: Partial<CommentThread> = {}): CommentThread {
  return fx.thread({
    artifact_id: 'art_1',
    version: { id: `ver_${n}`, number: n },
    author: { type: 'member', user_id: 'usr_1', name: 'Ada' },
    anchor: pointAt(0.3, 0.2),
    ...o,
  });
}

/** Version `n` of "Pricing", written `10 - n` hours ago. */
export function versionOf(n: number, o: Partial<VersionSummary> = {}): VersionSummary {
  return fx.version({
    id: `ver_${n}`,
    number: n,
    created_at: hoursAgo(10 - n),
    created_by: 'usr_1',
    is_current: false,
    ...o,
  });
}

export interface ReviewServer {
  /** What `GET /artifacts/art_1` answers now. */
  artifact: ArtifactSummary;
  /** Every version, the newest first. */
  versions: VersionSummary[];
  threads: CommentThread[];
  /** Makes version `n` current, adding it when it is new. */
  publish(n: number): void;
  /** Drops version `n`; the newest left becomes current. */
  remove(n: number): void;
  /** The version numbers whose review grant was asked for, in order. */
  previews: number[];
  /** Every request, as `METHOD /path?query`, in order. */
  requests: string[];
  /** The JSON bodies of thread creations. */
  created: unknown[];
  /** How many times `path` was read with GET. */
  gets(path: string): number;
}

/**
 * Serves the review screen of `art_1` "Pricing" in project `prj_2` "Launch
 * site": the sidebar, the artifact, its versions (`versions`, default 3/2/1,
 * the newest current) in pages of `versionPage` (default: all on one), each
 * version on its own, a review grant for each, and `threads`. Unknown
 * versions answer 404 in the server's words. Records every request.
 */
export function serveReview(
  o: { versions?: number[]; threads?: CommentThread[]; versionPage?: number } = {},
) {
  const numbers = o.versions ?? [3, 2, 1];
  const versions = [...numbers].sort((a, b) => b - a).map((n) => versionOf(n));
  const state: ReviewServer = {
    artifact: fx.artifact(),
    versions,
    threads: o.threads ?? [],
    previews: [],
    requests: [],
    created: [],
    publish(n) {
      if (!state.versions.some((v) => v.number === n)) state.versions.unshift(versionOf(n));
      state.versions.sort((a, b) => b.number - a.number);
      settle();
    },
    remove(n) {
      state.versions = state.versions.filter((v) => v.number !== n);
      settle();
    },
    gets: (path) => state.requests.filter((r) => r.split('?')[0] === `GET /api/v1${path}`).length,
  };

  /** The newest version is current, as on the server. */
  function settle(): void {
    state.versions = state.versions.map((v, i) => ({ ...v, is_current: i === 0 }));
    const current = state.versions[0] ?? null;
    state.artifact = fx.artifact({
      id: 'art_1',
      name: 'Pricing',
      project_id: 'prj_2',
      created_by: 'usr_1',
      current_version: current,
      latest_number: Math.max(0, ...state.versions.map((v) => v.number)),
    });
  }
  settle();

  const recorder = new AbortController();
  server.events.on(
    'request:start',
    ({ request }) => {
      const url = new URL(request.url);
      state.requests.push(`${request.method} ${url.pathname}${url.search}`);
    },
    { signal: recorder.signal },
  );
  onTestFinished(() => recorder.abort());

  serveSidebar({ projects: [launchSite] });
  server.use(
    http.get(`${API}/projects/prj_2`, () => HttpResponse.json(launchSite)),
    http.get(`${API}/artifacts/art_1`, () => HttpResponse.json(state.artifact)),
    http.get(`${API}/artifacts/art_1/versions`, ({ request }) => {
      const size = o.versionPage ?? state.versions.length;
      const from = Number(new URL(request.url).searchParams.get('cursor') ?? 0);
      const to = from + size;
      const next = to < state.versions.length ? String(to) : null;
      return HttpResponse.json(fx.page(state.versions.slice(from, to), next));
    }),
    http.get(`${API}/artifacts/art_1/versions/:n`, ({ params }) => {
      const version = state.versions.find((v) => v.number === Number(params.n));
      if (version === undefined) return apiError(404, 'not_found', 'This version does not exist.');
      return HttpResponse.json(version);
    }),
    http.get(`${API}/artifacts/art_1/versions/:n/preview`, ({ params, request }) => {
      const n = Number(params.n);
      if (new URL(request.url).searchParams.get('mode') !== 'review') {
        return apiError(400, 'invalid_request', 'Review only.');
      }
      if (!state.versions.some((v) => v.number === n)) {
        return apiError(404, 'not_found', 'This version does not exist.');
      }
      state.previews.push(n);
      return HttpResponse.json(fx.grant({ url: grantUrl(n) }));
    }),
    http.get(`${API}/artifacts/art_1/comments`, () => HttpResponse.json(fx.page(state.threads))),
    http.post(`${API}/artifacts/art_1/comments`, async ({ request }) => {
      const body = (await request.json()) as { body: string; anchor: Anchor; version_id?: string };
      state.created.push(body);
      const n = Number(body.version_id?.replace('ver_', '') ?? 0);
      const thread = threadOn(n, {
        id: `cmt_new${state.created.length}`,
        body: body.body,
        anchor: body.anchor,
        created_at: Date.now(),
      });
      state.threads = [...state.threads, thread];
      return HttpResponse.json(thread, { status: 201 });
    }),
  );
  return state;
}
