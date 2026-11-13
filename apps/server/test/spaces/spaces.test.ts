import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import type { Db } from '../../src/auth/passkeys.ts';
import type { UserRow } from '../../src/db/schema.ts';
import {
  createProject,
  DEFAULT_PROJECT_ID,
  ensureDefaultProject,
} from '../../src/domain/projects.ts';
import {
  assertCan,
  can,
  defaultProjectFor,
  forbiddenRole,
  type ProjectRole,
  roleIn,
  rolesIn,
  type Scope,
  type SpaceAction,
  SYSTEM_SCOPE,
  scopeForUser,
  scopeOf,
  teamDefaultProject,
  visibleCondition,
  whereVisible,
} from '../../src/domain/spaces.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import {
  addMember,
  type CaseIds,
  c,
  expectCase,
  MODES,
  type RestApi,
  sameAnswer,
  spacesContext,
  spacesFixture,
  T,
  UNKNOWN_IDS,
  withVisibility,
} from './fixture.ts';

type Rule = 'yes' | 'own' | 'no';

/** Spec §4.3, per action: owner, editor, viewer. "own": only what the editor published. */
const RULES: Record<SpaceAction, [Rule, Rule, Rule]> = {
  comment: ['yes', 'yes', 'yes'],
  publish: ['yes', 'yes', 'no'],
  editArtifact: ['yes', 'own', 'no'],
  deleteArtifact: ['yes', 'own', 'no'],
  deleteOthersComment: ['yes', 'no', 'no'],
  createShareLink: ['yes', 'yes', 'no'],
  revokeShareLink: ['yes', 'own', 'no'],
  manageProject: ['yes', 'no', 'no'],
  manageMembers: ['yes', 'no', 'no'],
};
const ROLES: ProjectRole[] = ['owner', 'editor', 'viewer'];
const ACTIONS = Object.keys(RULES) as SpaceAction[];

/** Every cell of the table, for something the person published and for something they did not. */
const CAN_TABLE = ACTIONS.flatMap((action) =>
  ROLES.flatMap((role, i) => {
    const rule = RULES[action][i];
    return [
      [role, action, 'own', rule !== 'no'] as const,
      [role, action, 'other', rule === 'yes'] as const,
    ];
  }),
);
const ME = 'usr_me';
const WORK = {
  own: { publishedBy: ME, userId: ME },
  other: { publishedBy: 'usr_else', userId: ME },
};

test.each(CAN_TABLE)('can(%s, %s) on %s work is %s', (role, action, whose, expected) => {
  expect(can(role, action, WORK[whose])).toBe(expected);
});

test('an editor owns nothing without a known publisher and user', () => {
  for (const ctx of [
    undefined,
    {},
    { publishedBy: null, userId: ME },
    { publishedBy: ME },
    { publishedBy: null },
  ]) {
    expect(can('editor', 'editArtifact', ctx)).toBe(false);
  }
});

/** A `Db` that fails on use, to show that something runs no query. */
const NO_DB = new Proxy({} as Db, {
  get() {
    throw new Error('no query expected');
  },
});

describe.each(dialects)('spaces on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx?.close());

  const person = async (name: string, o: { admin?: boolean } = {}): Promise<UserRow> => {
    const { user } = await createSignedInUser(ctx, {
      kind: 'oidc',
      name,
      ...(o.admin ? { idpRole: 'admin' } : {}),
    });
    return user;
  };
  /** `user`'s scope as a `team` instance would build it, on the same database. */
  const teamScope = (user: UserRow) => scopeForUser(withVisibility(ctx.deps, 'team'), user);
  const personalScope = (user: UserRow) => scopeForUser(withVisibility(ctx.deps, 'personal'), user);
  const db = () => ctx.deps.db.db;
  const projectsQuery = () => db().selectFrom('projects').select('id');
  const visibleIds = async (scope: Scope) =>
    (await whereVisible(projectsQuery(), scope, 'projects.id').execute()).map((r) => r.id).sort();

  test('whereVisible keeps a personal viewer to owned and shared projects', async () => {
    ctx = await spacesContext(dialect, 'personal');
    const [a, b, e] = [await person('A'), await person('B'), await person('E')];
    const P = await createProject(ctx.deps, a, { name: 'P' });
    const Q = await createProject(ctx.deps, a, { name: 'Q' });
    const R = await createProject(ctx.deps, b, { name: 'R' });
    await addMember(ctx, P.id, e.id, 'editor', a.id);
    const sorted = (...ids: string[]) => ids.sort();

    expect(await visibleIds(personalScope(e))).toEqual([P.id]);
    expect(await visibleIds(personalScope(a))).toEqual(sorted(P.id, Q.id));
    expect(await visibleIds(personalScope(b))).toEqual([R.id]);
    expect(await visibleIds(teamScope(e))).toEqual(sorted(P.id, Q.id, R.id));
    expect(await visibleIds(SYSTEM_SCOPE)).toEqual(sorted(P.id, Q.id, R.id));

    // The condition is a plain predicate on the column, so raw SQL can use it too.
    const condition = visibleCondition(personalScope(e), 'projects.id');
    if (condition === null) throw new Error('expected a condition in personal mode');
    const raw = await sql<{ id: string }>`select id from projects where ${condition}`.execute(db());
    expect(raw.rows.map((r) => r.id)).toEqual([P.id]);
    // On Postgres it also works under a row lock, which refuses a nullable side of an outer join.
    if (dialect === 'postgres') {
      const locked = await db()
        .transaction()
        .execute((trx) =>
          whereVisible(
            trx.selectFrom('projects').select('id').forUpdate(),
            personalScope(a),
            'projects.id',
          ).execute(),
        );
      expect(locked.map((r) => r.id).sort()).toEqual(sorted(P.id, Q.id));
    }
  });

  test('whereVisible adds nothing in team mode', async () => {
    ctx = await spacesContext(dialect, 'team');
    const user = await person('A');
    for (const scope of [teamScope(user), SYSTEM_SCOPE]) {
      expect(visibleCondition(scope, 'projects.id')).toBeNull();
      const query = projectsQuery();
      expect(whereVisible(query, scope, 'projects.id').compile().sql).toBe(query.compile().sql);
    }
    // A personal viewer's query does change.
    const query = projectsQuery();
    expect(whereVisible(query, personalScope(user), 'projects.id').compile().sql).not.toBe(
      query.compile().sql,
    );
  });

  test('roleIn answers owner, editor or viewer, and not-found for a stranger', async () => {
    ctx = await spacesContext(dialect, 'personal');
    const [a, e, v, s] = [
      await person('A'),
      await person('E'),
      await person('V'),
      await person('S'),
    ];
    const P = await createProject(ctx.deps, a, { name: 'P' });
    const Q = await createProject(ctx.deps, a, { name: 'Q' });
    await addMember(ctx, P.id, e.id, 'editor', a.id);
    await addMember(ctx, P.id, v.id, 'viewer', a.id);
    const notFound = { status: 404, code: 'not_found', message: t('project.notFound') };

    expect(await roleIn(db(), personalScope(a), P.id)).toBe('owner');
    expect(await roleIn(db(), personalScope(e), P.id)).toBe('editor');
    expect(await roleIn(db(), personalScope(v), P.id)).toBe('viewer');
    await expect(roleIn(db(), personalScope(s), P.id)).rejects.toMatchObject(notFound);
    await expect(roleIn(db(), personalScope(e), Q.id)).rejects.toMatchObject(notFound);
    await expect(roleIn(db(), personalScope(a), UNKNOWN_IDS.P)).rejects.toMatchObject(notFound);
    // Team mode and the system: everyone is an owner, and no query runs.
    expect(await roleIn(db(), teamScope(s), P.id)).toBe('owner');
    expect(await roleIn(NO_DB, teamScope(s), P.id)).toBe('owner');
    expect(await roleIn(NO_DB, SYSTEM_SCOPE, P.id)).toBe('owner');

    const ids = [P.id, Q.id, UNKNOWN_IDS.P];
    expect(await rolesIn(db(), personalScope(a), ids)).toEqual(
      new Map([
        [P.id, 'owner'],
        [Q.id, 'owner'],
      ]),
    );
    expect(await rolesIn(db(), personalScope(e), ids)).toEqual(new Map([[P.id, 'editor']]));
    expect(await rolesIn(db(), personalScope(v), ids)).toEqual(new Map([[P.id, 'viewer']]));
    expect(await rolesIn(db(), personalScope(s), ids)).toEqual(new Map());
    expect(await rolesIn(db(), personalScope(s), [])).toEqual(new Map());
    const everyOwner = new Map(ids.map((id) => [id, 'owner']));
    expect(await rolesIn(NO_DB, teamScope(s), ids)).toEqual(everyOwner);
    expect(await rolesIn(NO_DB, SYSTEM_SCOPE, ids)).toEqual(everyOwner);
  });

  test('assertCan refuses with reason role in personal mode only', async () => {
    ctx = await spacesContext(dialect, 'personal');
    const v = await person('V');
    /** What `assertCan` throws, or null when it lets the action through. */
    const refusal = (...args: Parameters<typeof assertCan>): unknown => {
      try {
        assertCan(...args);
        return null;
      } catch (error) {
        return error;
      }
    };
    expect(refusal(personalScope(v), 'viewer', 'publish')).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: t('spaces.role.publish'),
      details: { reason: 'role' },
    });
    expect(refusal(teamScope(v), 'viewer', 'publish')).toBeNull();
    expect(refusal(SYSTEM_SCOPE, 'viewer', 'manageMembers')).toBeNull();
    expect(refusal(personalScope(v), 'viewer', 'comment')).toBeNull();
    const own = { publishedBy: v.id, userId: v.id };
    expect(refusal(personalScope(v), 'editor', 'editArtifact', own)).toBeNull();
    expect(refusal(personalScope(v), 'editor', 'editArtifact')).toMatchObject({ status: 403 });
    // Every action has a message of its own.
    for (const action of ACTIONS) {
      const key = `spaces.role.${action}`;
      expect(t(key)).not.toBe(key);
      expect(forbiddenRole(action)).toMatchObject({
        status: 403,
        code: 'forbidden',
        message: t(key),
        details: { reason: 'role' },
      });
    }
  });

  test('each person gets a default project of their own', async () => {
    ctx = await spacesContext(dialect, 'personal');
    const [s, e] = [await person('S'), await person('E')];
    // Three at once per person: each ends up with one.
    const calls = [s, s, s, e, e, e].map((u) => defaultProjectFor(ctx.deps, personalScope(u)));
    const got = await Promise.all(calls);
    const rows = await db()
      .selectFrom('projects')
      .selectAll()
      .where('is_default', '=', 1)
      .execute();
    expect(rows).toHaveLength(2);
    for (const user of [s, e]) {
      const own = rows.filter((row) => row.owner_id === user.id);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({
        name: t('project.defaultName'),
        is_default: 1,
        created_by: user.id,
        archived_at: null,
      });
    }
    const idOf = (user: UserRow) => rows.find((row) => row.owner_id === user.id)?.id;
    expect(got.map((p) => p.id)).toEqual([s, s, s, e, e, e].map(idOf));
    expect(got[0]).toEqual(rows.find((row) => row.owner_id === s.id));
    // Asking again finds the same one.
    expect((await defaultProjectFor(ctx.deps, personalScope(s))).id).toBe(idOf(s));
  });

  test('the first person on an empty instance adopts the unowned default project', async () => {
    ctx = await spacesContext(dialect, 'personal');
    await ensureDefaultProject(ctx.deps);
    const [s, e] = [await person('S'), await person('E')];

    const adopted = await defaultProjectFor(ctx.deps, personalScope(s));
    expect(adopted).toMatchObject({ id: DEFAULT_PROJECT_ID, owner_id: s.id, is_default: 1 });
    const stored = await db()
      .selectFrom('projects')
      .select('owner_id')
      .where('id', '=', DEFAULT_PROJECT_ID)
      .executeTakeFirstOrThrow();
    expect(stored.owner_id).toBe(s.id);

    const another = await defaultProjectFor(ctx.deps, personalScope(e));
    expect(another.id).not.toBe(DEFAULT_PROJECT_ID);
    expect(another).toMatchObject({ owner_id: e.id, is_default: 1 });
    expect((await defaultProjectFor(ctx.deps, personalScope(s))).id).toBe(DEFAULT_PROJECT_ID);
  });

  test('an unowned default project holding artifacts is never adopted', async () => {
    ctx = await spacesContext(dialect, 'personal');
    await ensureDefaultProject(ctx.deps);
    await db()
      .insertInto('artifacts')
      .values({
        id: 'art_teamwork0000000000',
        project_id: DEFAULT_PROJECT_ID,
        name: 'From the team days',
        kind: 'html',
        current_version_id: null,
        latest_number: 0,
        created_by: null,
        created_at: T,
        updated_at: T,
      })
      .execute();
    const s = await person('S');

    const own = await defaultProjectFor(ctx.deps, personalScope(s));
    expect(own.id).not.toBe(DEFAULT_PROJECT_ID);
    expect(own).toMatchObject({ owner_id: s.id, is_default: 1 });
    const kept = await db()
      .selectFrom('projects')
      .select('owner_id')
      .where('id', '=', DEFAULT_PROJECT_ID)
      .executeTakeFirstOrThrow();
    expect(kept.owner_id).toBeNull();
  });

  test('team mode shares the oldest default project', async () => {
    ctx = await spacesContext(dialect, 'team');
    const [s, e] = [await person('S'), await person('E')];
    // None yet: the shared default is created.
    expect(await teamDefaultProject(db())).toBeUndefined();
    const created = await defaultProjectFor(ctx.deps, teamScope(s));
    expect(created).toMatchObject({ id: DEFAULT_PROJECT_ID, is_default: 1, owner_id: null });
    expect((await defaultProjectFor(ctx.deps, SYSTEM_SCOPE)).id).toBe(DEFAULT_PROJECT_ID);

    const defaultOf = async (id: string, owner: UserRow, createdAt: number) => {
      await db()
        .insertInto('projects')
        .values({
          id,
          name: t('project.defaultName'),
          instructions: '',
          is_default: 1,
          archived_at: null,
          created_by: owner.id,
          created_at: createdAt,
          updated_at: createdAt,
          owner_id: owner.id,
        })
        .execute();
    };
    // A later default (left from a personal period) does not change it.
    await defaultOf('prj_later000000000000000', s, T + 1);
    for (const scope of [teamScope(e), SYSTEM_SCOPE]) {
      expect((await defaultProjectFor(ctx.deps, scope)).id).toBe(DEFAULT_PROJECT_ID);
    }
    // The oldest wins by time, not by id.
    await defaultOf('prj_zzzzzzzzzzzzzzzzzzzz', e, T - 1);
    for (const scope of [teamScope(s), SYSTEM_SCOPE]) {
      expect((await defaultProjectFor(ctx.deps, scope)).id).toBe('prj_zzzzzzzzzzzzzzzzzzzz');
    }
    expect((await teamDefaultProject(db()))?.id).toBe('prj_zzzzzzzzzzzzzzzzzzzz');
  });

  test('scopes carry the configured visibility and the admin flag', async () => {
    ctx = await spacesContext(dialect, 'personal');
    const member = await person('M');
    const admin = await person('X', { admin: true });
    const { user: owner } = await createSignedInUser(ctx, { kind: 'owner', name: 'O' });

    expect(scopeForUser(ctx.deps, member)).toEqual({
      kind: 'viewer',
      user: member,
      visibility: 'personal',
      admin: false,
    });
    expect(scopeForUser(ctx.deps, admin)).toMatchObject({ visibility: 'personal', admin: true });
    expect(scopeForUser(ctx.deps, owner)).toMatchObject({ admin: true });
    expect(teamScope(member)).toMatchObject({ visibility: 'team', admin: false });

    // scopeOf reads the request's deps and caller.
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use(async (c, next) => {
      c.set('deps', ctx.deps);
      c.set('auth', c.req.header('x-who') === 'admin' ? { user: admin, via: 'session' } : null);
      await next();
    });
    app.get('/', (c) => c.json(scopeOf(c)));
    const signedIn = await app.request('/', { headers: { 'x-who': 'admin' } });
    expect(await signedIn.json()).toMatchObject({
      kind: 'viewer',
      user: { id: admin.id },
      visibility: 'personal',
      admin: true,
    });
    expect((await app.request('/')).status).toBe(401);
  });

  test.each(MODES)(
    'the IDOR fixture builds two spaces in %s mode, several to a context',
    async (mode) => {
      ctx = await spacesContext(dialect, mode);
      const fx = await spacesFixture(ctx);
      const again = await spacesFixture(ctx);
      expect(again.people.A.user.id).not.toBe(fx.people.A.user.id);
      expect(again.ids.P).not.toBe(fx.ids.P);

      const { A, E, V, X } = fx.people;
      const { ids } = fx;
      expect(X.user.idp_role).toBe('admin');
      expect(await roleIn(db(), personalScope(E.user), ids.P)).toBe('editor');
      expect(await roleIn(db(), personalScope(V.user), ids.P)).toBe('viewer');
      expect(await roleIn(db(), personalScope(A.user), ids.Q)).toBe('owner');
      const artifact = (id: string) =>
        db().selectFrom('artifacts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(await artifact(ids.p)).toMatchObject({ project_id: ids.P, latest_number: 2 });
      expect(await artifact(ids.q)).toMatchObject({ project_id: ids.Q, latest_number: 2 });
      expect(await artifact(ids.e)).toMatchObject({ project_id: ids.P, created_by: E.user.id });
      const comment = (id: string) =>
        db().selectFrom('comments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(await comment(ids.pThread)).toMatchObject({ artifact_id: ids.p, version_id: ids.pV1 });
      expect(await comment(ids.pReply)).toMatchObject({ parent_id: ids.pThread });
      expect(await comment(ids.eThread)).toMatchObject({
        artifact_id: ids.p,
        author_user_id: E.user.id,
      });

      // expectCase: the status for the mode, a refusal's reason, and a 404 replayed on unknown ids.
      const readP = c('A', 'read p', (api, i) => api.get(`/artifacts/${i.p}`), 200, 200);
      const editOthers = (api: RestApi, i: CaseIds) =>
        api.patch(`/comments/${i.pThread}`, { body: 'Not mine' });
      const missing = c(
        'A',
        'read nothing',
        (api) => api.get(`/artifacts/${UNKNOWN_IDS.q}`),
        404,
        404,
      );
      // Version 9 of p does not exist, but p does: a different 404 than for an unknown artifact.
      const telling = (api: RestApi, i: CaseIds) => api.get(`/artifacts/${i.p}/versions/9`);
      await expectCase(ctx, fx, mode, readP);
      await expectCase(ctx, fx, mode, c('E', "edit A's thread", editOthers, 403, 403, null));
      await expectCase(ctx, fx, mode, missing);
      // A team 403 is the 1.0 body whatever the case says; in personal mode the reason must match.
      const sayingRole = expectCase(
        ctx,
        fx,
        mode,
        c('E', "edit A's thread", editOthers, 403, 403, 'role'),
      );
      if (mode === 'team') await sayingRole;
      else await expect(sayingRole).rejects.toThrow(/details\.reason/);
      await expect(
        expectCase(ctx, fx, mode, c('A', 'version 9 of p', telling, 404, 404)),
      ).rejects.toThrow(/unknown id/);
    },
  );
});

test('sameAnswer ignores only the request id of an HTML page', () => {
  const page = (id: string, text: string) => `<p>${text}</p><p>Request id <code>${id}</code></p>`;
  sameAnswer(
    { status: 404, body: page('r1', 'Not found') },
    { status: 404, body: page('r2', 'Not found') },
  );
  expect(() =>
    sameAnswer(
      { status: 404, body: page('r1', 'Gone') },
      { status: 404, body: page('r1', 'Not found') },
    ),
  ).toThrow();
  expect(() => sameAnswer({ status: 403, body: {} }, { status: 404, body: {} })).toThrow();
});
