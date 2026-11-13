import { HttpResponse, http } from 'msw';
import { type AddMemberRequest, ProjectMember } from '../api/dto.ts';
import { API, server } from './server.ts';
import type { Call } from './settings.ts';

const ADDED = Date.UTC(2026, 10, 2);

/** A member of a project, in the owner's view: with an email. */
export function fxMember(o: Partial<ProjectMember> = {}): ProjectMember {
  return ProjectMember.parse({
    user: { id: 'usr_2', name: 'Grace Hopper', email: 'grace@example.com' },
    role: 'viewer',
    added_at: ADDED,
    ...o,
  });
}

/**
 * Serves the members of `projectId`: the list, and the writes the panel makes, which change
 * it the way the server does. `add` answers a POST (default: 201 for a new account named
 * after the email); an answer that is not an error joins the list. `calls` lists every write,
 * in order, with its path after `/api/v1` and its JSON body.
 */
export function serveMembers(o: {
  projectId: string;
  members: ProjectMember[];
  add?: (body: AddMemberRequest) => Response;
}): { calls: Call[] } {
  let members = o.members;
  const calls: Call[] = [];
  const base = `${API}/projects/${o.projectId}/members`;
  const record = async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/^.*\/api\/v1/, '');
    const text = await request.text();
    calls.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
  };
  const defaultAdd = (body: AddMemberRequest) =>
    HttpResponse.json(
      fxMember({
        user: { id: 'usr_new', name: body.email, email: body.email },
        role: body.role,
        added_at: Date.now(),
      }),
      { status: 201 },
    );

  server.use(
    http.get(base, () => HttpResponse.json({ items: members })),
    http.post(base, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as AddMemberRequest;
      const answer = (o.add ?? defaultAdd)(body);
      if (answer.ok) members = [...members, ProjectMember.parse(await answer.clone().json())];
      return answer;
    }),
    http.patch(`${base}/:userId`, async ({ request, params }) => {
      await record(request.clone());
      const { role } = (await request.json()) as { role: ProjectMember['role'] };
      members = members.map((m) => (m.user.id === params.userId ? { ...m, role } : m));
      const changed = members.find((m) => m.user.id === params.userId);
      return HttpResponse.json(changed);
    }),
    http.delete(`${base}/:userId`, async ({ request, params }) => {
      await record(request.clone());
      members = members.filter((m) => m.user.id !== params.userId);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { calls };
}
