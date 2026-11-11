import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  Comment,
  CommentBodyRequest,
  CommentThread,
  CommentThreadList,
  CreateThreadRequest,
  ErrorBody,
  ResolveRequest,
  ThreadQuery,
} from '@pinwall/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import {
  addReply,
  type CommentActor,
  createThread,
  deleteComment,
  editComment,
  listThreads,
  reopenThread,
  resolveThread,
} from '../domain/comments.ts';
import { jsonBodyLimit } from './body-limit.ts';
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
const missingArtifact = {
  404: error('The artifact does not exist (`not_found`)'),
  410: error('The artifact was deleted (`gone`)'),
};
const missingComment = {
  404: error('The comment does not exist (`not_found`)'),
  410: error('Its artifact was deleted (`gone`)'),
};

const listRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/comments',
  tags: ['comments'],
  summary: 'List the comment threads of an artifact',
  description:
    'Threads in the order they were written, each with its replies, oldest first. `status` keeps the open or the resolved ones; `version` keeps those written on that version number.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam, query: ThreadQuery },
  responses: {
    200: {
      description: 'A page of threads',
      content: { 'application/json': { schema: CommentThreadList } },
    },
    400: error('A bad `status`, `version`, `limit` or `cursor`'),
    ...authErrors,
    ...missingArtifact,
  },
});

const createThreadRoute = createRoute({
  method: 'post',
  path: '/artifacts/{id}/comments',
  tags: ['comments'],
  summary: 'Open a comment thread',
  description:
    'Writes the first comment of a thread, anchored to a spot of one page. Without `version_id` the thread is written on the current version.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: CreateThreadRequest } } },
  },
  responses: {
    201: {
      description: 'The new thread',
      content: { 'application/json': { schema: CommentThread } },
    },
    400: error('An invalid body or anchor, or a `version_id` of another artifact'),
    ...authErrors,
    ...missingArtifact,
  },
});

const replyRoute = createRoute({
  method: 'post',
  path: '/comments/{id}/replies',
  tags: ['comments'],
  summary: 'Reply in a thread',
  description:
    'Threads are flat: a reply to a reply joins the same thread. A reply belongs to the version its thread was written on.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: CommentBodyRequest } } },
  },
  responses: {
    201: { description: 'The reply', content: { 'application/json': { schema: Comment } } },
    400: error('An invalid body'),
    ...authErrors,
    ...missingComment,
  },
});

const editRoute = createRoute({
  method: 'patch',
  path: '/comments/{id}',
  tags: ['comments'],
  summary: 'Edit a comment',
  description: 'Replaces the text and sets `edited_at`. Only the author can edit a comment.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: CommentBodyRequest } } },
  },
  responses: {
    200: { description: 'The comment', content: { 'application/json': { schema: Comment } } },
    400: error('An invalid body'),
    401: error('Not signed in'),
    403: error('Not the author, or a cross-site request with the session cookie (`forbidden`)'),
    ...missingComment,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/comments/{id}',
  tags: ['comments'],
  summary: 'Delete a comment',
  description:
    "Deleting the first comment of a thread deletes the whole thread. The author, the artifact's publisher or an admin can delete a comment.",
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    204: { description: 'Deleted' },
    401: error('Not signed in'),
    403: error(
      "Neither the author, the artifact's publisher nor an admin, or a cross-site request with the session cookie (`forbidden`)",
    ),
    ...missingComment,
  },
});

const resolveRoute = createRoute({
  method: 'post',
  path: '/comments/{id}/resolve',
  tags: ['comments'],
  summary: 'Resolve a thread',
  description:
    'Marks the thread resolved in version `version_id`, or in the current version when the body leaves it out (or there is no body). `id` names the first comment of the thread.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: false, content: { 'application/json': { schema: ResolveRequest } } },
  },
  responses: {
    200: {
      description: 'The thread',
      content: { 'application/json': { schema: CommentThread } },
    },
    400: error('`id` is a reply, or `version_id` names a version of another artifact'),
    ...authErrors,
    ...missingComment,
  },
});

const reopenRoute = createRoute({
  method: 'post',
  path: '/comments/{id}/reopen',
  tags: ['comments'],
  summary: 'Reopen a thread',
  description: '`id` names the first comment of the thread.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'The thread',
      content: { 'application/json': { schema: CommentThread } },
    },
    400: error('`id` is a reply'),
    ...authErrors,
    ...missingComment,
  },
});

const noStore = { 'Cache-Control': 'no-store' };

function memberOf(c: Context<AppEnv>): CommentActor {
  return { kind: 'member', user: authOf(c).user };
}

export function registerCommentRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { status, version, limit, cursor } = c.req.valid('query');
    const { items, nextCursor } = await listThreads(c.var.deps, id, {
      status,
      ...(version === undefined ? {} : { versionNumber: version }),
      limit,
      cursor: cursor ?? null,
    });
    return c.json({ items, next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(createThreadRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { body, anchor, version_id } = c.req.valid('json');
    const thread = await createThread(c.var.deps, memberOf(c), id, {
      body,
      anchor,
      versionId: version_id ?? null,
    });
    return c.json(thread, 201, noStore);
  });

  api.openapi(replyRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { body } = c.req.valid('json');
    const { comment } = await addReply(c.var.deps, memberOf(c), id, body);
    return c.json(comment, 201, noStore);
  });

  api.openapi(editRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { body } = c.req.valid('json');
    const { comment } = await editComment(c.var.deps, memberOf(c), id, body);
    return c.json(comment, 200, noStore);
  });

  api.openapi(deleteRoute, async (c) => {
    await deleteComment(c.var.deps, memberOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });

  api.openapi(resolveRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { version_id } = c.req.valid('json');
    const thread = await resolveThread(c.var.deps, authOf(c).user, id, version_id ?? null);
    return c.json(thread, 200, noStore);
  });

  api.openapi(reopenRoute, async (c) => {
    const thread = await reopenThread(c.var.deps, authOf(c).user, c.req.valid('param').id);
    return c.json(thread, 200, noStore);
  });
}
