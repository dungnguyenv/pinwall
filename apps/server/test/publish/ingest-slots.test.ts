import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PublishSession } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { t } from '../../src/lib/i18n.ts';
import {
  INGEST_RETRY_AFTER_SECONDS,
  INGESTS_AT_ONCE,
  INGESTS_PER_PERSON,
  takeIngestSlot,
} from '../../src/publish/ingest-slots.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { aroundSpoolStores } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import { type Person, spacesClient } from '../spaces/fixture.ts';

const PAGE = '<!doctype html><p>Hello</p>';

/** What a publish answers: its status, `Retry-After` and body. */
interface Answer {
  status: number;
  retryAfter: string | null;
  body: unknown;
}

async function answerOf(res: Response): Promise<Answer> {
  const text = await res.text();
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: text === '' ? null : JSON.parse(text),
  };
}

/** The 429 of a publish refused for want of a place: the person's own, or everyone's. */
function busy(reason: 'publishes_running' | 'server_busy'): Answer {
  return {
    status: 429,
    retryAfter: String(INGEST_RETRY_AFTER_SECONDS),
    body: {
      error: {
        code: 'rate_limited',
        message:
          reason === 'publishes_running'
            ? t('publish.busy.person', { max: INGESTS_PER_PERSON })
            : t('publish.busy.server'),
        details: { retry_after_seconds: INGEST_RETRY_AFTER_SECONDS, reason },
      },
    },
  };
}

describe.each(dialects)('publishes in progress on %s', (dialect) => {
  let ctx: TestContext;
  let ada: Person;
  let bob: Person;
  let cat: Person;
  /** An artifact of Ada's with one version, to restore. */
  let adaArtifact: { id: string; versionId: string };

  async function person(name: string): Promise<Person> {
    const { user, cookie } = await createSignedInUser(ctx, { kind: 'oidc', name });
    return { user, cookie, token: await createUserToken(ctx, user.id) };
  }

  beforeEach(async () => {
    ctx = await createTestContext({ dialect });
    ada = await person('Ada');
    bob = await person('Bob');
    cat = await person('Cat');
    const { artifact, version } = await publishFiles(ctx, ada.user, { 'index.html': PAGE });
    adaArtifact = { id: artifact.id, versionId: version.id };
  });
  afterEach(() => ctx.close());

  /** A fresh upload URL of `who`'s, made before anything is published to it. */
  async function uploadUrl(who: Person): Promise<string> {
    const made = await restClient(ctx, who.cookie).post('/publish-sessions', { target: {} });
    expect(made.status).toBe(201);
    return new URL(PublishSession.parse(made.body).upload_url).pathname;
  }

  const postTo = (path: string) =>
    ctx.request(path, { method: 'POST', body: PAGE, headers: { 'content-type': 'text/html' } });

  /** Every way `who` publishes; `uploadPath` is an upload URL of theirs for the first one. */
  const ways = {
    'an upload URL': async (_who: Person, uploadPath: string) => answerOf(await postTo(uploadPath)),
    'a web upload': async (who: Person) => {
      const form = new FormData();
      form.append('target', '{}');
      form.append('file', new Blob([PAGE], { type: 'text/html' }), 'index.html');
      const r = await spacesClient(ctx, who.cookie).form('/publish/upload', form);
      return { status: r.status, retryAfter: r.headers.get('retry-after'), body: r.body };
    },
    'an inline publish': async (who: Person) => {
      const r = await restClient(ctx, who.cookie).post('/publish/inline', {
        target: {},
        files: [{ path: 'index.html', content: PAGE }],
      });
      return { status: r.status, retryAfter: r.headers.get('retry-after'), body: r.body };
    },
    'a restore': async (who: Person) => {
      const current = await ctx.deps.db.db
        .selectFrom('artifacts')
        .select('current_version_id')
        .where('id', '=', adaArtifact.id)
        .executeTakeFirstOrThrow();
      const r = await restClient(ctx, who.cookie).post(
        `/artifacts/${adaArtifact.id}/versions/1/restore`,
        { expected_version_id: current.current_version_id },
      );
      return { status: r.status, retryAfter: r.headers.get('retry-after'), body: r.body };
    },
  };

  /** `publish_inline` over MCP as `who`: whether it failed, and its text. */
  async function mcpPublish(who: Person): Promise<{ isError: boolean; text: string }> {
    const agent = await connectMcp(ctx, { bearer: who.token });
    try {
      const r = (await agent.callTool({
        name: 'publish_inline',
        arguments: { files: [{ path: 'index.html', content: PAGE }] },
      })) as CallToolResult;
      return { isError: r.isError === true, text: toolText(r) };
    } finally {
      await agent.close();
    }
  }

  test(`a person with ${INGESTS_PER_PERSON} publishes in progress is refused another, whichever way, until one ends`, async () => {
    const uploadPath = await uploadUrl(ada);
    const running = Array.from({ length: INGESTS_PER_PERSON }, () =>
      takeIngestSlot(ctx.deps, ada.user.id),
    );

    for (const [name, publish] of Object.entries(ways)) {
      expect(await publish(ada, uploadPath), name).toEqual(busy('publishes_running'));
    }
    const refused = await mcpPublish(ada);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(t('publish.busy.person', { max: INGESTS_PER_PERSON }));
    // The bound is Ada's own: Bob publishes meanwhile.
    expect((await ways['an inline publish'](bob)).status).toBe(201);

    running[0]?.();
    for (const [name, publish] of Object.entries(ways)) {
      expect((await publish(ada, uploadPath)).status, name).toBe(201);
    }
    expect((await mcpPublish(ada)).isError).toBe(false);
    for (const release of running) release();
  });

  test(`the instance runs at most ${INGESTS_AT_ONCE} publishes at once, everyone's together`, async () => {
    const uploadPath = await uploadUrl(ada);
    const running = [bob, cat].flatMap((who) =>
      Array.from({ length: INGESTS_AT_ONCE / 2 }, () => takeIngestSlot(ctx.deps, who.user.id)),
    );

    for (const [name, publish] of Object.entries(ways)) {
      expect(await publish(ada, uploadPath), name).toEqual(busy('server_busy'));
    }
    running[0]?.();
    expect((await ways['an inline publish'](ada)).status).toBe(201);
    for (const release of running) release();
  });

  test('a publish gives its place back however it ends', async () => {
    const inline = (content: string, path = 'index.html') =>
      restClient(ctx, ada.cookie).post('/publish/inline', {
        target: {},
        files: [{ path, content }],
      });
    for (let i = 0; i < INGESTS_PER_PERSON + 2; i += 1) {
      // A binary file sent inline: 400, after the publish took its place.
      expect((await inline('x', 'image.png')).status).toBe(400);
      expect((await inline(`<p>${i}</p>`)).status).toBe(201);
    }
    const uploadPath = await uploadUrl(ada);
    const refused = await ctx.request(uploadPath, {
      method: 'POST',
      body: 'not an archive',
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(refused.status).toBe(415);
    for (let i = 0; i < INGESTS_PER_PERSON; i += 1) {
      expect((await ways['a web upload'](ada)).status).toBe(201);
    }
  });

  test('uploads still streaming hold their places, and the same upload URL works once one ends', async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Each upload stays in progress, its file read but not yet stored, until the gate opens.
    const spool = aroundSpoolStores(ctx.deps.blobs, async (store) => {
      await gate;
      await store();
    });
    const paths = [await uploadUrl(ada), await uploadUrl(ada)];
    const third = await uploadUrl(ada);
    const inFlight = paths.map((path) => postTo(path));
    await vi.waitFor(() => expect(spool).toHaveBeenCalledTimes(INGESTS_PER_PERSON));

    expect(await answerOf(await postTo(third))).toEqual(busy('publishes_running'));
    open();
    for (const res of await Promise.all(inFlight)) expect(res.status).toBe(201);
    // Refused for want of a place, the upload URL was given back.
    expect((await postTo(third)).status).toBe(201);
    spool.mockRestore();
  });
});
