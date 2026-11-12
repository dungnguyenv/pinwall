import { type Context, Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import type { AppEnv, AuthContext } from '../../src/app.ts';
import {
  authOf,
  requireAdmin,
  requireAuth,
  requireOwner,
  requireSession,
} from '../../src/auth/guards.ts';
import { effectiveRole, hasAccess } from '../../src/auth/roles.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { t } from '../../src/lib/i18n.ts';

const member: UserRow = {
  id: 'usr_member',
  kind: 'oidc',
  email: 'm@example.test',
  email_verified: 1,
  name: 'Member',
  avatar_url: null,
  idp_role: 'member',
  role_override: null,
  oidc_issuer: 'https://idp.example.test',
  oidc_subject: 'm',
  idp_refresh_token: null,
  idp_checked_at: 0,
  disabled_at: null,
  disabled_reason: null,
  created_at: 0,
  last_seen_at: null,
};
const owner: UserRow = { ...member, id: 'usr_owner', kind: 'owner', idp_role: null };

describe('roles', () => {
  test('effectiveRole: the owner is admin, else an override, else the IdP role', () => {
    expect(effectiveRole(owner)).toBe('admin');
    expect(effectiveRole(member)).toBe('member');
    expect(effectiveRole({ ...member, idp_role: 'admin' })).toBe('admin');
    expect(effectiveRole({ ...member, idp_role: null })).toBeNull();
    expect(effectiveRole({ ...member, role_override: 'admin' })).toBe('admin');
    expect(effectiveRole({ ...member, idp_role: 'admin', role_override: 'member' })).toBe('member');
  });

  test('an admin or member override holds only while the IdP admits the person; blocked always', () => {
    for (const role_override of ['admin', 'member'] as const) {
      const dropped = { ...member, idp_role: null, role_override };
      expect(effectiveRole(dropped), role_override).toBeNull();
      expect(hasAccess(dropped), role_override).toBe(false);
    }
    for (const idp_role of ['admin', 'member', null] as const) {
      const blocked = { ...member, idp_role, role_override: 'blocked' as const };
      expect(effectiveRole(blocked), String(idp_role)).toBe('blocked');
      expect(hasAccess(blocked), String(idp_role)).toBe(false);
    }
  });

  test('the owner is always an admin: an override stored on the owner is ignored', () => {
    for (const role_override of ['admin', 'member', 'blocked'] as const) {
      expect(effectiveRole({ ...owner, role_override })).toBe('admin');
    }
    expect(hasAccess({ ...owner, role_override: 'blocked' })).toBe(true);
    expect(hasAccess({ ...owner, role_override: 'blocked', disabled_at: 1 })).toBe(false);
  });

  test('hasAccess needs a role and an enabled account', () => {
    expect(hasAccess(owner)).toBe(true);
    expect(hasAccess(member)).toBe(true);
    expect(hasAccess({ ...member, idp_role: null })).toBe(false);
    expect(hasAccess({ ...member, role_override: 'blocked' })).toBe(false);
    expect(hasAccess({ ...owner, disabled_at: 1 })).toBe(false);
  });
});

describe('guards', () => {
  function appWith(auth: AuthContext | null): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set('auth', auth);
      await next();
    });
    const ok = (c: Context<AppEnv>) => c.json({ ok: true });
    app.get('/auth', requireAuth, (c) => c.json({ id: authOf(c).user.id }));
    app.get('/admin', requireAdmin, ok);
    app.get('/session', requireSession, ok);
    app.get('/owner', requireOwner, ok);
    app.get('/unguarded', (c) => c.json({ id: authOf(c).user.id }));
    app.onError(errorHandler);
    return app;
  }

  const status = async (auth: AuthContext | null, path: string) =>
    (await appWith(auth).request(`http://localhost/${path}`)).status;

  test('every guard refuses an anonymous request with 401', async () => {
    for (const path of ['auth', 'admin', 'session', 'owner', 'unguarded']) {
      const r = await appWith(null).request(`http://localhost/${path}`);
      expect(r.status, path).toBe(401);
      expect(await r.json()).toEqual({
        error: { code: 'unauthorized', message: t('auth.signInRequired') },
      });
    }
  });

  test('requireAuth admits anyone signed in and authOf returns them', async () => {
    const r = await appWith({ user: member, via: 'api_token' }).request('http://localhost/auth');
    expect(await r.json()).toEqual({ id: member.id });
  });

  test('requireAdmin needs the admin role', async () => {
    const r = await appWith({ user: member, via: 'session' }).request('http://localhost/admin');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: { code: 'forbidden', message: t('auth.adminOnly') },
    });
    expect(await status({ user: owner, via: 'api_token' }, 'admin')).toBe(200);
    expect(
      await status({ user: { ...member, role_override: 'admin' }, via: 'oauth' }, 'admin'),
    ).toBe(200);
  });

  test('requireSession refuses API and OAuth tokens', async () => {
    for (const via of ['api_token', 'oauth'] as const) {
      const r = await appWith({ user: owner, via }).request('http://localhost/session');
      expect(r.status, via).toBe(403);
      expect(await r.json()).toEqual({
        error: { code: 'forbidden', message: t('auth.sessionRequired') },
      });
    }
    expect(await status({ user: member, via: 'session', sessionId: 'h' }, 'session')).toBe(200);
  });

  test('requireOwner needs the built-in owner', async () => {
    const r = await appWith({ user: { ...member, idp_role: 'admin' }, via: 'session' }).request(
      'http://localhost/owner',
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: { code: 'forbidden', message: t('auth.ownerOnly') },
    });
    expect(await status({ user: owner, via: 'api_token' }, 'owner')).toBe(200);
  });
});
