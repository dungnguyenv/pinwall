import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Me, PublicConfig } from '@pinwall/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { usageOf } from '../../src/domain/usage.ts';
import { formatBytes } from '../../src/lib/format.ts';
import { t } from '../../src/lib/i18n.ts';
import { WhoamiOut } from '../../src/mcp/schemas.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { restClient } from '../helpers/rest.ts';
import { type Person, spacesFixture } from '../spaces/fixture.ts';
import { approve, contextWith, moderationContext, setQuota } from './helpers.ts';

test('the loader reads the D8 settings', () => {
  const none = loadConfig({});
  expect([none.abuseContact, none.termsUrl, none.privacyUrl]).toEqual([null, null, null]);

  expect(loadConfig({ PINWALL_ABUSE_CONTACT: 'abuse@example.org' }).abuseContact).toBe(
    'abuse@example.org',
  );
  expect(loadConfig({ PINWALL_ABUSE_CONTACT: 'https://example.org/report' }).abuseContact).toBe(
    'https://example.org/report',
  );
  expect(() => loadConfig({ PINWALL_ABUSE_CONTACT: 'call us' })).toThrow(
    /PINWALL_ABUSE_CONTACT: must be an email address or an http\(s\) URL/,
  );
  expect(() => loadConfig({ PINWALL_ABUSE_CONTACT: 'ftp://example.org/report' })).toThrow(
    /PINWALL_ABUSE_CONTACT: must be an email address or an http\(s\) URL/,
  );

  const policies = loadConfig({
    PINWALL_TERMS_URL: 'https://example.org/terms',
    PINWALL_PRIVACY_URL: 'http://example.org/privacy',
  });
  expect(policies.termsUrl).toBe('https://example.org/terms');
  expect(policies.privacyUrl).toBe('http://example.org/privacy');
  expect(() => loadConfig({ PINWALL_TERMS_URL: 'ftp://x' })).toThrow(
    /PINWALL_TERMS_URL: must be an http\(s\) URL/,
  );
  expect(() => loadConfig({ PINWALL_PRIVACY_URL: 'privacy' })).toThrow(
    /PINWALL_PRIVACY_URL: must be an http\(s\) URL/,
  );
});

describe.each(dialects)('/me, whoami and the public config on %s', (dialect) => {
  let team: TestContext;
  let personal: TestContext;
  beforeAll(async () => {
    team = await moderationContext(dialect, 'team');
    personal = contextWith(team, { visibility: 'personal' });
  });
  afterAll(() => team?.close());

  const meOf = async (ctx: TestContext, person: Person) => {
    const r = await restClient(ctx, person.cookie).get('/me');
    expect(r.status).toBe(200);
    return r.body as Record<string, unknown>;
  };

  test('public config names the share policy and the D8 links only when they are set', async () => {
    const publicConfig = async (ctx: TestContext) => {
      const res = await ctx.request('/api/v1/config/public');
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    };
    const keys = ['share_links', 'abuse_contact', 'terms_url', 'privacy_url'];

    const plain = await publicConfig(team);
    for (const key of keys) expect(plain, key).not.toHaveProperty(key);
    expect(PublicConfig.parse(plain)).toEqual(plain);

    // Members may share, as in 1.0: the policy is not worth a key.
    const open = await publicConfig(contextWith(team, { shareLinks: 'members' }));
    expect(open).not.toHaveProperty('share_links');

    const set = await publicConfig(
      contextWith(team, {
        shareLinks: 'approved',
        abuseContact: 'abuse@example.org',
        termsUrl: 'https://example.org/terms',
        privacyUrl: 'https://example.org/privacy',
      }),
    );
    expect(set).toMatchObject({
      share_links: 'approved',
      abuse_contact: 'abuse@example.org',
      terms_url: 'https://example.org/terms',
      privacy_url: 'https://example.org/privacy',
    });
    expect(PublicConfig.parse(set)).toEqual(set);

    // Each one stands alone.
    const onlyTerms = await publicConfig(contextWith(team, { termsUrl: 'https://example.org/t' }));
    expect(onlyTerms).toMatchObject({ terms_url: 'https://example.org/t' });
    for (const key of ['share_links', 'abuse_contact', 'privacy_url']) {
      expect(onlyTerms, key).not.toHaveProperty(key);
    }
  });

  test('/me tells whether the person may create share links, only when links need approval', async () => {
    const fx = await spacesFixture(team);
    const { E, X } = fx.people;
    expect(await meOf(team, E)).not.toHaveProperty('can_create_share_links');
    expect(await meOf(team, X)).not.toHaveProperty('can_create_share_links');

    const ap = contextWith(team, { shareLinks: 'approved' });
    expect(await meOf(ap, E)).toMatchObject({ can_create_share_links: false });
    expect(await meOf(ap, X)).toMatchObject({ can_create_share_links: true });
    await approve(team, E.user.id);
    const approved = await meOf(ap, E);
    expect(approved).toMatchObject({ can_create_share_links: true });
    expect(Me.parse(approved)).toEqual(approved);
  });

  test('/me shows usage and limits in personal mode or when a quota applies', async () => {
    const fx = await spacesFixture(team);
    const { A, E, X } = fx.people;
    const usage = (ctx: TestContext, person: Person) =>
      usageOf(ctx.deps.db.db, ctx.deps.config, person.user.id);

    // A team with no quota and no override answers as 1.0 did.
    const plain = await meOf(team, A);
    expect(plain).not.toHaveProperty('usage');
    expect(plain).not.toHaveProperty('limits');

    // In personal mode everyone has a space, so everyone sees it, with no limit by default.
    const own = await usage(personal, A);
    expect(own.artifacts).toBeGreaterThan(0);
    expect(own.bytes).toBeGreaterThan(0);
    const mine = await meOf(personal, A);
    expect(mine).toMatchObject({ usage: own, limits: { bytes: null, artifacts: null } });
    expect(Me.parse(mine)).toEqual(mine);

    // A team with an instance quota: each person sees theirs, admins have none.
    const capped = await moderationContext(dialect, 'team', {
      PINWALL_QUOTA_BYTES: '500MB',
    });
    try {
      const cfx = await spacesFixture(capped);
      const { A: ca, X: cx } = cfx.people;
      expect(await meOf(capped, ca)).toMatchObject({
        usage: await usage(capped, ca),
        limits: { bytes: 500_000_000, artifacts: null },
      });
      expect(await meOf(capped, cx)).toMatchObject({ limits: { bytes: null, artifacts: null } });
    } finally {
      await capped.close();
    }

    // An override on one person is enough in a team with no quota.
    await setQuota(team, E.user.id, { artifacts: 3 });
    expect(await meOf(team, E)).toMatchObject({
      usage: await usage(team, E),
      limits: { bytes: null, artifacts: 3 },
    });
    expect(await meOf(team, X)).not.toHaveProperty('usage');
    await setQuota(team, E.user.id, { artifacts: null, bytes: 0 });
    expect(await meOf(team, E)).toMatchObject({ limits: { bytes: null, artifacts: null } });
  });

  describe('whoami', () => {
    const whoami = async (ctx: TestContext, person: Person) => {
      const client = await connectMcp(ctx, { bearer: person.token });
      try {
        return (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult & {
          structuredContent: WhoamiOut;
        };
      } finally {
        await client.close();
      }
    };

    test('adds the mode, usage, quota and link permission under the same rules', async () => {
      const fx = await spacesFixture(team);
      const { A, X } = fx.people;
      const { config } = team.deps;

      // A team with the defaults answers exactly as 1.0 did.
      const plain = await whoami(team, A);
      expect(plain.structuredContent).toEqual({
        user: { id: A.user.id, name: 'A', email: A.user.email, role: 'member' },
        via: 'api_token',
        pinwall_url: config.publicOrigin,
        isolation: config.isolation.mode,
        limits: {
          max_upload_bytes: config.limits.maxUploadBytes,
          max_inline_bytes: config.limits.maxInlineBytes,
          max_file_bytes: config.limits.maxFileBytes,
          max_version_bytes: config.limits.maxVersionBytes,
          max_files: config.limits.maxFiles,
        },
        upload_url_ttl_seconds: Math.floor(config.ttl.uploadSessionMs / 1000),
        authoring_notes: [
          t('mcp.notes.entry'),
          t('mcp.notes.relativeLinks'),
          t('mcp.notes.selfContained'),
          t('mcp.notes.opaqueOrigin'),
        ],
      });
      const text = toolText(plain);
      expect(text).not.toContain(t('mcp.whoami.noShareLinks'));
      expect(text).not.toContain(t('mcp.whoami.space', spaceCopy(0, 0)));

      // Personal mode, with links that need approval.
      const ap = contextWith(personal, { shareLinks: 'approved' });
      const own = await usageOf(ap.deps.db.db, ap.deps.config, A.user.id);
      expect(own.artifacts).toBeGreaterThan(0);
      const blocked = await whoami(ap, A);
      expect(blocked.structuredContent).toMatchObject({
        visibility: 'personal',
        usage: own,
        quota: { bytes: null, artifacts: null },
        can_create_share_links: false,
      });
      expect(WhoamiOut.parse(blocked.structuredContent)).toEqual(blocked.structuredContent);
      const lines = toolText(blocked).split('\n');
      expect(lines).toContain(t('mcp.whoami.space', spaceCopy(own.bytes, own.artifacts)));
      expect(lines).toContain(t('mcp.whoami.noShareLinks'));

      // An admin may share, and has no limit.
      const admin = await whoami(ap, X);
      expect(admin.structuredContent.can_create_share_links).toBe(true);
      expect(toolText(admin)).not.toContain(t('mcp.whoami.noShareLinks'));

      // A limit is said in the text, in numbers.
      await setQuota(team, A.user.id, { bytes: 1_500_000, artifacts: 4 });
      const limited = await whoami(ap, A);
      expect(limited.structuredContent.quota).toEqual({ bytes: 1_500_000, artifacts: 4 });
      expect(toolText(limited).split('\n')).toContain(
        t('mcp.whoami.space', {
          bytes: formatBytes(own.bytes),
          bytesLimit: formatBytes(1_500_000),
          artifacts: own.artifacts,
          artifactsLimit: 4,
        }),
      );
    });
  });
});

/** The values of the usage line of `whoami` for a person with no limits. */
function spaceCopy(bytes: number, artifacts: number) {
  return {
    bytes: formatBytes(bytes),
    bytesLimit: t('mcp.whoami.noLimit'),
    artifacts,
    artifactsLimit: t('mcp.whoami.noLimit'),
  };
}
