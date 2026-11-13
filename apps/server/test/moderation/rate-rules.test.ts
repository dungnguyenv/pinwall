import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PublishSession } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { RATE_RULES, type RateRule } from '../../src/auth/rate-limits.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import type { Reply } from '../helpers/rest.ts';
import {
  type Person,
  type RestApi,
  type SpacesFixture,
  sameAnswer,
  spacesClient,
  spacesFixture,
  UNKNOWN_IDS,
} from '../spaces/fixture.ts';
import { exhaustRate, moderationContext } from './helpers.ts';

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** What the MCP tools say when a rule refuses: the 1.0 text, with the seconds to wait. */
const REFUSED_BY_RATE = ['Too many requests', 'retry_after_seconds'];

let pageNumber = 0;
/** A page of its own, so each publish is told apart in the tests' failure messages. */
const page = (label: string) => `<!doctype html><p>${label} ${++pageNumber}</p>`;

/** A web upload's form: the target (a new artifact), then `html` as `index.html`. */
function uploadForm(html: string): FormData {
  const form = new FormData();
  form.append('target', JSON.stringify({}));
  form.append('file', new File([html], 'index.html'));
  return form;
}

/** The body of a REST inline publish to a new artifact. */
const inlineBody = (label: string) => ({
  target: {},
  files: [{ path: 'index.html', content: page(label) }],
});

/** Runs `work` as an MCP agent holding `who`'s API token: `call` runs a tool. */
async function asAgent(
  ctx: TestContext,
  who: Person,
  work: (
    call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => Promise<void>,
): Promise<void> {
  const agent = await connectMcp(ctx, { bearer: who.token });
  try {
    await work(
      async (name, args) => (await agent.callTool({ name, arguments: args })) as CallToolResult,
    );
  } finally {
    await agent.close();
  }
}

function expectRefusedByRate(r: CallToolResult): void {
  expect(r.isError).toBe(true);
  for (const text of REFUSED_BY_RATE) expect(toolText(r)).toContain(text);
}

describe.each(dialects)('per-person rate rules on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let fx: SpacesFixture;
  beforeAll(async () => {
    ctx = await moderationContext(dialect, 'team');
    clock = ctx.deps.clock as FixedClock;
  });
  // Every rule counts per user id, so each test's own people start with all their allowances.
  beforeEach(async () => {
    fx = await spacesFixture(ctx);
  });
  afterAll(() => ctx?.close());

  test('publish: 60 per 10 minutes over sessions, inline, web upload and restore together', async () => {
    const { A, E } = fx.people;
    const api = spacesClient(ctx, A.cookie);
    // The version p stands at; each restore puts a new one on top.
    let current = fx.ids.pV2;
    const ways: Record<string, () => Promise<Reply>> = {
      'publish session': () => api.post('/publish-sessions', { target: {} }),
      inline: () => api.post('/publish/inline', inlineBody('inline')),
      'web upload': () => api.form('/publish/upload', uploadForm(page('web'))),
      restore: async () => {
        const r = await api.post<{ id: string }>(`/artifacts/${fx.ids.p}/versions/1/restore`, {
          expected_version_id: current,
        });
        if (r.status === 201) current = r.body.id;
        return r;
      },
    };

    for (let i = 0; i < 15; i++) {
      for (const [name, send] of Object.entries(ways)) {
        const r = await send();
        expect(r.status, `${name} ${i + 1}: ${JSON.stringify(r.body)}`).toBe(201);
      }
    }
    for (const [name, send] of Object.entries(ways)) {
      const r = await send();
      expect(r.status, `${name} over the limit`).toBe(429);
      const wait = Number(r.headers.get('retry-after'));
      expect(wait, `${name}: Retry-After`).toBeGreaterThan(0);
      expect(wait, `${name}: Retry-After`).toBeLessThanOrEqual(600);
      expect(r.body).toMatchObject({ error: { code: 'rate_limited' } });
    }

    await asAgent(ctx, A, async (call) => {
      expectRefusedByRate(
        await call('publish_inline', { files: [{ path: 'index.html', content: page('mcp') }] }),
      );
      expectRefusedByRate(await call('create_publish_session', {}));
    });
    // The allowance is A's own.
    expect(
      (await spacesClient(ctx, E.cookie).post('/publish/inline', inlineBody('E'))).status,
    ).toBe(201);

    clock.advance(600_000);
    expect((await api.post('/publish/inline', inlineBody('later'))).status).toBe(201);
  });

  test('MCP publishes count in the same allowance of 60', async () => {
    const { A } = fx.people;
    await exhaustRate(ctx, RATE_RULES.publish, A.user.id, 58);
    await asAgent(ctx, A, async (call) => {
      expect((await call('create_publish_session', {})).isError).toBeFalsy();
      const inline = await call('publish_inline', {
        files: [{ path: 'index.html', content: page('mcp') }],
      });
      expect(inline.isError, toolText(inline)).toBeFalsy();
      expectRefusedByRate(
        await call('publish_inline', { files: [{ path: 'index.html', content: page('mcp') }] }),
      );
    });
    const r = await spacesClient(ctx, A.cookie).post('/publish/inline', inlineBody('rest'));
    expect(r.status).toBe(429);
  });

  test('an upload URL is counted once, when it is made', async () => {
    const { A } = fx.people;
    const api = spacesClient(ctx, A.cookie);
    const first = PublishSession.parse((await api.post('/publish-sessions', { target: {} })).body);
    for (let i = 1; i < 60; i++) {
      expect((await api.post('/publish-sessions', { target: {} })).status).toBe(201);
    }
    expect((await api.post('/publish-sessions', { target: {} })).status).toBe(429);

    // The URL needs no credential and is not counted again: its session was.
    const uploaded = await ctx.request(first.upload_url, {
      method: 'POST',
      body: page('upload'),
      headers: { 'content-type': 'text/html' },
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    expect((await api.post('/publish-sessions', { target: {} })).status).toBe(429);
  });

  test('grant: 600 per hour over preview grants and raw links', async () => {
    const { A, E } = fx.people;
    const preview = (who: Person) =>
      spacesClient(ctx, who.cookie).get(`/artifacts/${fx.ids.p}/versions/1/preview`);
    const rawLink = (who: Person) =>
      ctx.request(`/a/${fx.ids.p}/raw`, {
        headers: { cookie: who.cookie, accept: BROWSER },
        redirect: 'manual',
      });

    await exhaustRate(ctx, RATE_RULES.grant, A.user.id, 599);
    expect((await preview(A)).status).toBe(200);
    const refused = await preview(A);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: 'rate_limited' } });
    const page429 = await rawLink(A);
    expect(page429.status).toBe(429);
    expect(page429.headers.get('content-type')).toContain('text/html');
    expect(await page429.text()).toContain('Too many requests');
    expect(Number(page429.headers.get('retry-after'))).toBeGreaterThan(0);
    // The allowance is A's own, and the review mode of a preview is a grant like the rest.
    expect((await preview(E)).status).toBe(200);

    // The raw links draw on the same hour: E's last grant is one.
    await exhaustRate(ctx, RATE_RULES.grant, E.user.id, 598);
    expect((await rawLink(E)).status).toBe(302);
    expect((await preview(E)).status).toBe(429);
    clock.advance(3_600_000);
    expect((await preview(A)).status).toBe(200);
  });

  test('shareLinkCreate: 30 per hour, REST and MCP together', async () => {
    const { A } = fx.people;
    const api = spacesClient(ctx, A.cookie);
    const make = () => api.post(`/artifacts/${fx.ids.p}/share-links`, {});
    for (let i = 0; i < 20; i++) expect((await make()).status, `REST ${i + 1}`).toBe(201);
    await asAgent(ctx, A, async (call) => {
      const create = () => call('create_share_link', { artifact_id: fx.ids.p });
      for (let i = 0; i < 10; i++) {
        const r = await create();
        expect(r.isError, `MCP ${i + 1}: ${toolText(r)}`).toBeFalsy();
      }
      expectRefusedByRate(await create());
    });
    const refused = await make();
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(3600);

    clock.advance(3_600_000);
    expect((await make()).status).toBe(201);
  });

  test('projectCreate: 30 per hour, REST and MCP together', async () => {
    const { A } = fx.people;
    const api = spacesClient(ctx, A.cookie);
    const make = (i: number) => api.post('/projects', { name: `Project ${i}` });
    for (let i = 0; i < 20; i++) expect((await make(i)).status, `REST ${i + 1}`).toBe(201);
    await asAgent(ctx, A, async (call) => {
      const create = (i: number) => call('create_project', { name: `Agent project ${i}` });
      for (let i = 0; i < 10; i++) {
        const r = await create(i);
        expect(r.isError, `MCP ${i + 1}: ${toolText(r)}`).toBeFalsy();
      }
      expectRefusedByRate(await create(10));
    });
    const refused = await make(20);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: 'rate_limited' } });

    clock.advance(3_600_000);
    expect((await make(21)).status).toBe(201);
  });

  test('admins have the same limits', async () => {
    const { X } = fx.people;
    await exhaustRate(ctx, RATE_RULES.projectCreate, X.user.id, 30);
    const refused = await spacesClient(ctx, X.cookie).post('/projects', { name: 'Admin project' });
    expect(refused.status).toBe(429);
  });
});

describe.each(dialects)('rate refusals reveal nothing about other spaces on %s', (dialect) => {
  let ctx: TestContext;
  let fx: SpacesFixture;
  beforeAll(async () => {
    ctx = await moderationContext(dialect, 'personal');
  });
  beforeEach(async () => {
    fx = await spacesFixture(ctx);
  });
  afterAll(() => ctx?.close());

  /** Requests that name an artifact, with the rule that refuses them. */
  const NAMING_AN_ARTIFACT: [string, RateRule, (api: RestApi, id: string) => Promise<Reply>][] = [
    [
      'publish: restore',
      RATE_RULES.publish,
      (api, id) =>
        api.post(`/artifacts/${id}/versions/1/restore`, { expected_version_id: 'ver_unknown' }),
    ],
    [
      'grant: preview',
      RATE_RULES.grant,
      (api, id) => api.get(`/artifacts/${id}/versions/1/preview`),
    ],
    [
      'shareLinkCreate: share link',
      RATE_RULES.shareLinkCreate,
      (api, id) => api.post(`/artifacts/${id}/share-links`, {}),
    ],
  ];

  // S is a stranger to P, so p is not found for S, as an id that names nothing is.
  test.each(NAMING_AN_ARTIFACT)(
    '%s: a stranger over the limit gets one answer for both ids',
    async (_name, rule, send) => {
      const { S } = fx.people;
      const api = spacesClient(ctx, S.cookie);
      await exhaustRate(ctx, rule, S.user.id, rule.limit);
      const refused = await send(api, fx.ids.p);
      expect(refused.status).toBe(429);
      sameAnswer(refused, await send(api, UNKNOWN_IDS.p));
    },
  );

  test('a raw link answers the same for a visible and an unknown id', async () => {
    const { S } = fx.people;
    await exhaustRate(ctx, RATE_RULES.grant, S.user.id, RATE_RULES.grant.limit);
    const raw = async (id: string) => {
      const res = await ctx.request(`/a/${id}/raw`, {
        headers: { cookie: S.cookie, accept: BROWSER },
        redirect: 'manual',
      });
      return { status: res.status, body: await res.text() };
    };
    const refused = await raw(fx.ids.p);
    expect(refused.status).toBe(429);
    sameAnswer(refused, await raw(UNKNOWN_IDS.p));
  });

  test('MCP: a stranger over the limit gets one answer for a visible and an unknown id', async () => {
    const { S } = fx.people;
    await exhaustRate(ctx, RATE_RULES.shareLinkCreate, S.user.id, RATE_RULES.shareLinkCreate.limit);
    await asAgent(ctx, S, async (call) => {
      const refused = await call('create_share_link', { artifact_id: fx.ids.p });
      expectRefusedByRate(refused);
      expect(toolText(await call('create_share_link', { artifact_id: UNKNOWN_IDS.p }))).toBe(
        toolText(refused),
      );
    });
  });
});
