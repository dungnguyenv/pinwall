import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ErrorBody, ProjectMember, ProjectMemberList, UpdateMemberRequest } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { requireAuth } from '../auth/guards.ts';
import { listMembers, removeMember, setMemberRole } from '../domain/members.ts';
import { scopeOf } from '../domain/spaces.ts';
import { notFoundHandler } from '../http/errors.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { IdParam } from './pagination.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];

/** Members exist only in `personal` mode: in `team` mode, before authentication, an unknown route. */
const personalOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.deps.config.visibility !== 'personal') return notFoundHandler(c);
  await next();
};

const MemberParam = IdParam.extend({ user_id: z.string().min(1).max(100) });

const PERSONAL_ONLY = 'Personal mode only; in team mode it answers 404 like an unknown route.';
const notSignedIn = { 401: error('Not signed in') };
const unknownProject = error(
  'No such project, one the caller is neither the owner nor a member of, or team mode (`not_found`)',
);
const ownerOnly = error(
  "Someone other than the project's owner (`forbidden`, `details.reason` `role`), or a cross-site request with the session cookie (`forbidden`)",
);

const listMembersRoute = createRoute({
  method: 'get',
  path: '/projects/{id}/members',
  tags: ['members'],
  summary: "List a project's members",
  description: `The people the owner let into the project, oldest first; the owner is not listed (see the project's \`owner\`). Only the owner sees their emails. Every member may list them. ${PERSONAL_ONLY}`,
  middleware: [personalOnly, requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'The members',
      content: { 'application/json': { schema: ProjectMemberList } },
    },
    ...notSignedIn,
    403: error('A cross-site request with the session cookie (`forbidden`)'),
    404: unknownProject,
  },
});

const updateMemberRoute = createRoute({
  method: 'patch',
  path: '/projects/{id}/members/{user_id}',
  tags: ['members'],
  summary: "Change a member's role",
  description: `Makes the member an \`editor\` or a \`viewer\`. Only the project's owner may. ${PERSONAL_ONLY}`,
  middleware: [personalOnly, requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: MemberParam,
    body: { required: true, content: { 'application/json': { schema: UpdateMemberRequest } } },
  },
  responses: {
    200: {
      description: "The member, in the owner's view",
      content: { 'application/json': { schema: ProjectMember } },
    },
    400: error('Invalid fields'),
    ...notSignedIn,
    403: ownerOnly,
    404: error(
      'No such project, one the caller cannot see, team mode, or `user_id` is not a member (`not_found`)',
    ),
  },
});

const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/projects/{id}/members/{user_id}',
  tags: ['members'],
  summary: 'Remove a member, or leave a project',
  description: `The owner removes the member \`user_id\`; a member whose own id it is leaves the project. Only the owner may remove someone else. ${PERSONAL_ONLY}`,
  middleware: [personalOnly, requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: MemberParam },
  responses: {
    204: { description: 'Removed, or left' },
    ...notSignedIn,
    403: ownerOnly,
    404: error(
      'No such project, one the caller cannot see, team mode, or `user_id` is not a member, the owner included (`not_found`)',
    ),
  },
});

const noStore = { 'Cache-Control': 'no-store' };

export function registerMemberRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listMembersRoute, async (c) => {
    const items = await listMembers(c.var.deps, scopeOf(c), c.req.valid('param').id);
    return c.json({ items }, 200, noStore);
  });

  api.openapi(updateMemberRoute, async (c) => {
    const { id, user_id: userId } = c.req.valid('param');
    const { role } = c.req.valid('json');
    const member = await setMemberRole(c.var.deps, scopeOf(c), id, userId, role);
    return c.json(member, 200, noStore);
  });

  api.openapi(removeMemberRoute, async (c) => {
    const { id, user_id: userId } = c.req.valid('param');
    await removeMember(c.var.deps, scopeOf(c), id, userId);
    return c.body(null, 204, noStore);
  });
}
