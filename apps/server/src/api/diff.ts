import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { DiffQuery, ErrorBody, MarkdownDiff, TextFileDiff, VersionDiff } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAuth } from '../auth/guards.ts';
import { diffMarkdownFile, diffTextFile, diffVersionFiles } from '../domain/diff.ts';
import { scopeOf } from '../domain/spaces.ts';
import { IdParam } from './pagination.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const authErrors = {
  401: error('Not signed in'),
  403: error('A cross-site request with the session cookie (`forbidden`)'),
};
const missing = {
  404: error('The artifact, a version or the file does not exist (`not_found`)'),
  410: error('The artifact or a version was deleted (`gone`)'),
};

const FilesQuery = DiffQuery.omit({ path: true });
const FileQuery = DiffQuery.required({ path: true });

const versionsRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/diff',
  tags: ['versions'],
  summary: 'List the files that changed between two versions',
  description:
    'Compares by content hash, so a file that was rewritten with the same bytes is not listed. Sorted by path. `from` may be newer than `to`; added and removed then swap.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam, query: FilesQuery },
  responses: {
    200: {
      description: 'The changed files',
      content: { 'application/json': { schema: VersionDiff } },
    },
    400: error('A missing or bad `from` or `to`'),
    ...authErrors,
    ...missing,
  },
});

const fileRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/diff/file',
  tags: ['versions'],
  summary: 'The unified diff of one file between two versions',
  description:
    'A version without the file counts as an empty one. `patch` is null when the file is not compared: `binary` for anything that is not text, `too_large` over 1,000,000 bytes or 50,000 lines a side, or when the two sides differ too much to compare in bounded time. Compare binary files by `old` and `new` (size and hash).',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam, query: FileQuery },
  responses: {
    200: {
      description: 'The diff of the file',
      content: { 'application/json': { schema: TextFileDiff } },
    },
    400: error('A missing or bad `from`, `to` or `path`'),
    ...authErrors,
    ...missing,
  },
});

const markdownRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/diff/markdown',
  tags: ['versions'],
  summary: 'A rendered, block-by-block diff of a Markdown file',
  description:
    "`path` defaults to the entry file of version `to`. Each block carries the HTML it renders to. That HTML comes from the artifact and is untrusted: show it only in a sandboxed frame (`<iframe sandbox srcdoc>`), never in the app's own page. A side over 200,000 bytes is not rendered: `too_large` is true and `blocks` empty; use the text diff then.",
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam, query: DiffQuery },
  responses: {
    200: {
      description: 'The blocks of the file, in document order',
      content: { 'application/json': { schema: MarkdownDiff } },
    },
    400: error('A bad query, or the file is not Markdown (`bad_request`)'),
    ...authErrors,
    ...missing,
  },
});

const noStore = { 'Cache-Control': 'no-store' };

export function registerDiffRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(versionsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { from, to } = c.req.valid('query');
    const files = await diffVersionFiles(c.var.deps, scopeOf(c), id, from, to);
    return c.json({ from, to, files }, 200, noStore);
  });

  api.openapi(fileRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { from, to, path } = c.req.valid('query');
    return c.json(await diffTextFile(c.var.deps, scopeOf(c), id, from, to, path), 200, noStore);
  });

  api.openapi(markdownRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { from, to, path } = c.req.valid('query');
    return c.json(await diffMarkdownFile(c.var.deps, scopeOf(c), id, from, to, path), 200, noStore);
  });
}
