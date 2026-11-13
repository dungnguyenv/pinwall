import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { openAdmissionWarning, startSpaces } from '../../src/domain/spaces-startup.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { signInWithIdp } from '../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp } from '../helpers/oidc-idp.ts';

const OIDC = { PINWALL_OIDC_ISSUER: 'https://idp.example', PINWALL_OIDC_CLIENT_ID: 'c' };

describe('openAdmissionWarning', () => {
  test('team mode with open admission is warned about at start', () => {
    const open = loadConfig(OIDC);
    expect(openAdmissionWarning(open)).toMatch(
      /anyone the identity provider signs in .*every project/,
    );
    // Not a configuration warning: it is logged by startSpaces, so config.warnings is 1.0's.
    expect(open.warnings).toEqual([]);
  });

  test.each([
    ['a member domain', { ...OIDC, PINWALL_MEMBER_DOMAINS: 'example.com' }],
    ['a member email', { ...OIDC, PINWALL_MEMBER_EMAILS: 'ada@example.com' }],
    [
      'a member group',
      { ...OIDC, PINWALL_OIDC_ROLES_CLAIM: 'groups', PINWALL_OIDC_MEMBER_GROUPS: 'staff' },
    ],
    ['personal mode', { ...OIDC, PINWALL_VISIBILITY: 'personal' }],
    ['no identity provider', {}],
  ])('there is none with %s', (_name, env) => {
    expect(openAdmissionWarning(loadConfig(env))).toBeNull();
  });

  // An admin rule alone does not decide who is a member.
  test('admin groups and emails are not a member rule', () => {
    const env = {
      ...OIDC,
      PINWALL_OIDC_ROLES_CLAIM: 'groups',
      PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
      PINWALL_ADMIN_EMAILS: 'boss@example.com',
    };
    expect(openAdmissionWarning(loadConfig(env))).not.toBeNull();
  });
});

let idp: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
});
afterAll(() => idp?.close());

describe.each(dialects)('startup warnings on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx?.close());

  test('startSpaces logs the open-admission warning once', async () => {
    ctx = await createTestContext({ dialect, env: OIDC });
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    await startSpaces(ctx.deps);
    expect(warn.mock.calls).toEqual([[openAdmissionWarning(ctx.deps.config)]]);
  });

  test('startSpaces logs nothing when a member rule is set or the mode is personal', async () => {
    for (const env of [
      { ...OIDC, PINWALL_MEMBER_DOMAINS: 'example.com' },
      { ...OIDC, PINWALL_VISIBILITY: 'personal' },
    ]) {
      ctx = await createTestContext({ dialect, env });
      const warn = vi.spyOn(ctx.deps.logger, 'warn');
      await startSpaces(ctx.deps);
      expect(warn).not.toHaveBeenCalled();
      await ctx.close();
    }
  });

  test('a token without the roles claim is not logged when no member group rule exists', async () => {
    ctx = await createTestContext({
      dialect,
      env: idp.env({
        PINWALL_OIDC_ROLES_CLAIM: 'groups',
        PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
      }),
    });
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    const sub = `user-${randomUUID()}`;
    idp.addAccount({
      sub,
      name: 'Ada Example',
      email: 'ada@example.com',
      email_verified: true,
      groups: undefined,
    });
    expect((await signInWithIdp(ctx, idp, { as: sub })).status).toBe(302);
    const user = await ctx.deps.db.db
      .selectFrom('users')
      .select('idp_role')
      .where('oidc_subject', '=', sub)
      .executeTakeFirstOrThrow();
    expect(user.idp_role).toBe('member');
    expect(
      warn.mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.includes('roles claim')),
    ).toEqual([]);
  });
});
