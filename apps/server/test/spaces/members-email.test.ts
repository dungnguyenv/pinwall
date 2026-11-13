import { MemberCandidate, type ProjectList, ProjectMember } from '@pinwall/shared';
import type { Updateable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { DbDialect } from '../../src/db/connect.ts';
import type { MemberRole, UserKind, UsersTable } from '../../src/db/schema.ts';
import { createProject } from '../../src/domain/projects.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { type ErrorJson, type Reply, restClient } from '../helpers/rest.ts';
import {
  type Person,
  sameAnswer,
  spacesContext,
  spacesFixture,
  T,
  UNKNOWN_IDS,
} from './fixture.ts';

const membersOf = (projectId: string) => `/projects/${projectId}/members`;

const clockOf = (ctx: TestContext) => ctx.deps.clock as FixedClock;

function expectStatus(r: Reply, status: number) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

/** The `project_members` rows of `projectId`, as `user_id: role`. */
async function storedRoles(ctx: TestContext, projectId: string) {
  const rows = await ctx.deps.db.db
    .selectFrom('project_members')
    .select(['user_id', 'role'])
    .where('project_id', '=', projectId)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

type Account = Pick<Person, 'user' | 'cookie'>;

/**
 * A signed-in person made with `createSignedInUser`, then given `email` (and the rest of `set`)
 * by updating their `users` row. Returns the row as stored afterwards.
 */
async function personWith(
  ctx: TestContext,
  o: { kind: UserKind; name: string; email: string; set?: Updateable<UsersTable> },
): Promise<Account> {
  const { user, cookie } = await createSignedInUser(ctx, { kind: o.kind, name: o.name });
  const { db } = ctx.deps.db;
  await db
    .updateTable('users')
    .set({ email: o.email, ...o.set })
    .where('id', '=', user.id)
    .execute();
  const stored = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  return { user: stored, cookie };
}

/** An email nobody else uses, for one account. */
let emails = 0;
const freshEmail = () => `person-${++emails}@example.test`;

const NOBODY = 'nobody@example.test';

const noAccount = {
  error: { code: 'not_found', message: t('spaces.members.noAccount'), details: { field: 'email' } },
} satisfies ErrorJson;

const self = {
  error: { code: 'bad_request', message: t('spaces.members.self'), details: { field: 'email' } },
} satisfies ErrorJson;

const forbiddenRole = {
  error: {
    code: 'forbidden',
    message: t('spaces.role.manageMembers'),
    details: { reason: 'role' },
  },
} satisfies ErrorJson;

/** `person` as a member with `role`, added at `addedAt`, in the owner's view. */
const asMember = (person: Account, role: MemberRole, addedAt = T): ProjectMember => ({
  user: { id: person.user.id, name: person.user.name, email: person.user.email },
  role,
  added_at: addedAt,
});

/**
 * Three accounts with one email in `ctx`: O, the local owner account (unverified, as an owner
 * account always is), at T; D, an OIDC account with a verified email written in other capitals,
 * a second later; U, an OIDC account whose email the IdP did not verify.
 */
async function sameEmailAccounts(ctx: TestContext) {
  const O = await personWith(ctx, { kind: 'owner', name: 'Owner', email: 'same@example.test' });
  clockOf(ctx).advance(1000);
  const D = await personWith(ctx, { kind: 'oidc', name: 'Danny', email: 'Same@Example.TEST' });
  const U = await personWith(ctx, {
    kind: 'oidc',
    name: 'Unverified',
    email: 'same@example.test',
    set: { email_verified: 0 },
  });
  return { O, D, U };
}

describe.each(dialects)('adding project members by email on %s', (dialect: DbDialect) => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await spacesContext(dialect, 'personal');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  // Every test builds its own fixture, at T: a test that moves the clock leaves the next one at T.
  beforeEach(() => {
    clockOf(ctx).set(T);
  });

  const as = (person: Account, on: TestContext = ctx) => restClient(on, person.cookie);

  /** Runs `body` in a personal-mode context of its own, for accounts that share an email. */
  async function inOwnContext(body: (own: TestContext) => Promise<void>): Promise<void> {
    const own = await spacesContext(dialect, 'personal');
    try {
      await body(own);
    } finally {
      await own.close();
    }
  }

  test('the owner adds a user by email, whatever its letter case', async () => {
    const fx = await spacesFixture(ctx);
    const { A, E, S, V } = fx.people;

    const added = await as(A).post(membersOf(fx.ids.P), {
      email: S.user.email?.toUpperCase(),
      role: 'viewer',
    });
    expectStatus(added, 201);
    expect(added.headers.get('cache-control')).toBe('no-store');
    ProjectMember.parse(added.body);
    expect(added.body).toEqual({
      user: { id: S.user.id, name: 'S', email: S.user.email },
      role: 'viewer',
      added_at: T,
    });
    expect(await storedRoles(ctx, fx.ids.P)).toEqual({
      [E.user.id]: 'editor',
      [V.user.id]: 'viewer',
      [S.user.id]: 'viewer',
    });

    const listed = await as(S).get<ProjectList>('/projects');
    expectStatus(listed, 200);
    expect(listed.body.items.find((project) => project.id === fx.ids.P)).toMatchObject({
      role: 'viewer',
    });
  });

  test('an email no active account uses answers not-found, saying to ask them to sign in once first', async () => {
    const fx = await spacesFixture(ctx);
    const { A } = fx.people;
    const before = await storedRoles(ctx, fx.ids.P);
    const add = (email: string) => as(A).post(membersOf(fx.ids.P), { email, role: 'viewer' });

    const nobody = await add(NOBODY);
    expectStatus(nobody, 404);
    expect(nobody.body).toEqual(noAccount);
    expect(t('spaces.members.noAccount')).toContain('sign in to Pinwall once first');

    const inactive: [string, Account][] = [
      [
        'an OIDC account whose email is not verified',
        await personWith(ctx, {
          kind: 'oidc',
          name: 'Unverified',
          email: freshEmail(),
          set: { email_verified: 0 },
        }),
      ],
      [
        'a disabled account',
        await personWith(ctx, {
          kind: 'oidc',
          name: 'Disabled',
          email: freshEmail(),
          set: { disabled_at: T, disabled_reason: 'test' },
        }),
      ],
      [
        'a blocked account',
        await personWith(ctx, {
          kind: 'oidc',
          name: 'Blocked',
          email: freshEmail(),
          set: { role_override: 'blocked' },
        }),
      ],
      [
        'an account the IdP no longer admits',
        await personWith(ctx, {
          kind: 'oidc',
          name: 'Dropped',
          email: freshEmail(),
          set: { idp_role: null },
        }),
      ],
    ];
    for (const [name, person] of inactive) {
      const r = await add(person.user.email ?? '');
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(404);
      expect(r.body, name).toEqual(noAccount);
    }
    expect(await storedRoles(ctx, fx.ids.P)).toEqual(before);

    // The local owner account has no verified flag; its email still counts.
    const owner = await personWith(ctx, { kind: 'owner', name: 'Owner', email: freshEmail() });
    const added = await add(owner.user.email ?? '');
    expectStatus(added, 201);
    expect(added.body).toEqual(asMember(owner, 'viewer'));
  });

  test('several accounts with one email: the owner chooses, and only that one is added', async () => {
    await inOwnContext(async (own) => {
      const fx = await spacesFixture(own);
      const { A, E, V } = fx.people;
      const { O, D, U } = await sameEmailAccounts(own);
      const members = membersOf(fx.ids.P);
      const before = await storedRoles(own, fx.ids.P);

      const ask = await as(A, own).post<ErrorJson>(members, {
        email: 'same@example.test',
        role: 'editor',
      });
      expectStatus(ask, 409);
      expect(ask.body).toEqual({
        error: {
          code: 'conflict',
          message: t('spaces.members.severalAccounts'),
          details: {
            reason: 'several_accounts',
            candidates: [
              { user_id: O.user.id, name: 'Owner', kind: 'owner' },
              { user_id: D.user.id, name: 'Danny', kind: 'oidc' },
            ],
          },
        },
      });
      MemberCandidate.array().parse(ask.body.error.details?.candidates);
      expect(await storedRoles(own, fx.ids.P)).toEqual(before);

      const picked = await as(A, own).post(members, {
        email: 'same@example.test',
        role: 'editor',
        user_id: D.user.id,
      });
      expectStatus(picked, 201);
      expect(picked.body).toEqual(asMember(D, 'editor', T + 1000));
      expect(await storedRoles(own, fx.ids.P)).toEqual({
        [E.user.id]: 'editor',
        [V.user.id]: 'viewer',
        [D.user.id]: 'editor',
      });

      const unverified = await as(A, own).post(members, {
        email: 'same@example.test',
        role: 'editor',
        user_id: U.user.id,
      });
      expectStatus(unverified, 404);
      expect(unverified.body).toEqual(noAccount);
      expect(await storedRoles(own, fx.ids.P)).not.toHaveProperty(U.user.id);
    });
  });

  test('the owner may be among the accounts offered, but cannot pick themselves', async () => {
    await inOwnContext(async (own) => {
      const { O, D } = await sameEmailAccounts(own);
      const R = await createProject(own.deps, D.user, { name: 'R' });
      const members = membersOf(R.id);
      const add = { email: 'same@example.test', role: 'viewer' };

      const ask = await as(D, own).post<ErrorJson>(members, add);
      expectStatus(ask, 409);
      expect(ask.body.error.details?.candidates).toEqual([
        { user_id: O.user.id, name: 'Owner', kind: 'owner' },
        { user_id: D.user.id, name: 'Danny', kind: 'oidc' },
      ]);

      const themselves = await as(D, own).post(members, { ...add, user_id: D.user.id });
      expectStatus(themselves, 400);
      expect(themselves.body).toEqual(self);
      expect(await storedRoles(own, R.id)).toEqual({});

      const owner = await as(D, own).post(members, { ...add, user_id: O.user.id });
      expectStatus(owner, 201);
      expect(owner.body).toEqual(asMember(O, 'viewer', T + 1000));
      expect(await storedRoles(own, R.id)).toEqual({ [O.user.id]: 'viewer' });
    });
  });

  test('the owner cannot add themselves', async () => {
    const fx = await spacesFixture(ctx);
    const { A } = fx.people;
    const before = await storedRoles(ctx, fx.ids.P);

    const r = await as(A).post(membersOf(fx.ids.P), { email: A.user.email, role: 'editor' });
    expectStatus(r, 400);
    expect(r.body).toEqual(self);
    expect(await storedRoles(ctx, fx.ids.P)).toEqual(before);
  });

  test('adding a member twice is a conflict and changes nothing', async () => {
    const fx = await spacesFixture(ctx);
    const { A, E, V } = fx.people;

    const r = await as(A).post(membersOf(fx.ids.P), { email: E.user.email, role: 'viewer' });
    expectStatus(r, 409);
    expect(r.body).toEqual({
      error: {
        code: 'conflict',
        message: t('spaces.members.already'),
        details: { reason: 'already_member' },
      },
    });
    expect(await storedRoles(ctx, fx.ids.P)).toEqual({
      [E.user.id]: 'editor',
      [V.user.id]: 'viewer',
    });
  });

  test('a user_id that is not one of the matching accounts answers like no account', async () => {
    const fx = await spacesFixture(ctx);
    const { A, S, V } = fx.people;
    const before = await storedRoles(ctx, fx.ids.P);

    const r = await as(A).post(membersOf(fx.ids.P), {
      email: S.user.email,
      role: 'viewer',
      user_id: V.user.id,
    });
    expectStatus(r, 404);
    expect(r.body).toEqual(noAccount);
    expect(await storedRoles(ctx, fx.ids.P)).toEqual(before);
  });

  test('members, strangers and admins learn nothing about emails', async () => {
    const fx = await spacesFixture(ctx);
    const { E, S, V, X } = fx.people;
    const before = await storedRoles(ctx, fx.ids.P);
    const known = { email: S.user.email, role: 'viewer' };
    const unknown = { email: NOBODY, role: 'viewer' };

    for (const person of [E, V]) {
      const withAccount = await as(person).post(membersOf(fx.ids.P), known);
      const without = await as(person).post(membersOf(fx.ids.P), unknown);
      expectStatus(withAccount, 403);
      expect(withAccount.body, person.user.name ?? '').toEqual(forbiddenRole);
      expect(without.status).toBe(withAccount.status);
      expect(without.body).toEqual(withAccount.body);
    }

    for (const person of [S, X]) {
      for (const body of [known, unknown]) {
        const r = await as(person).post(membersOf(fx.ids.P), body);
        expectStatus(r, 404);
        sameAnswer(r, await as(person).post(membersOf(UNKNOWN_IDS.P), body));
      }
    }
    expect(await storedRoles(ctx, fx.ids.P)).toEqual(before);
  });

  test('add-by-email attempts are limited to 30 an hour per person', async () => {
    const fx = await spacesFixture(ctx);
    const { A, E, S } = fx.people;
    const members = membersOf(fx.ids.P);
    const newcomer = (name: string) => personWith(ctx, { kind: 'oidc', name, email: freshEmail() });
    const newcomers = [await newcomer('B'), await newcomer('C'), await newcomer('D')];
    const N = await newcomer('N');

    // 3 additions, then 9 rounds of the 3 refusals: 30 attempts.
    const added: [unknown, number][] = newcomers.map((person) => [
      { email: person.user.email, role: 'viewer' },
      201,
    ]);
    const refused: [unknown, number][] = [
      [{ email: NOBODY, role: 'viewer' }, 404],
      [{ email: E.user.email, role: 'viewer' }, 409],
      [{ email: 'x' }, 400],
    ];
    const tries = [...added, ...Array.from({ length: 9 }, () => refused).flat()];
    expect(tries).toHaveLength(30);
    for (const [i, [body, status]] of tries.entries()) {
      const r = await as(A).post(members, body);
      expect(r.status, `attempt ${i + 1}: ${JSON.stringify(r.body)}`).toBe(status);
    }
    expect(new Set(tries.map(([, status]) => status))).toEqual(new Set([201, 404, 409, 400]));

    const addN = { email: N.user.email, role: 'viewer' };
    const limited = await as(A).post<ErrorJson>(members, addN);
    expectStatus(limited, 429);
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(limited.body.error).toMatchObject({
      code: 'rate_limited',
      details: { retry_after_seconds: 3600 },
    });
    expect(await storedRoles(ctx, fx.ids.P)).not.toHaveProperty(N.user.id);

    // A stranger's probes count against their own limit; nobody else's.
    for (let i = 1; i <= 30; i++) {
      const r = await as(S).post(members, { email: NOBODY, role: 'viewer' });
      expect(r.status, `S, attempt ${i}: ${JSON.stringify(r.body)}`).toBe(404);
    }
    expectStatus(await as(S).post(members, { email: NOBODY, role: 'viewer' }), 429);
    expectStatus(await as(E).post(members, { email: NOBODY, role: 'viewer' }), 403);

    clockOf(ctx).advance(3_600_000);
    const later = await as(A).post(members, addN);
    expectStatus(later, 201);
    expect(later.body).toEqual(asMember(N, 'viewer', T + 3_600_000));
  });
});
