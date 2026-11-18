import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { createThread } from '../../src/domain/comments.ts';
import { t } from '../../src/lib/i18n.ts';
import { tryReadSlot } from '../../src/publish/read-slots.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { callText, connectMcp } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { sampleAnchor } from '../helpers/review.ts';

const PAGE = '<!doctype html>\n<p>Xem Bảng giá mới</p>\n';

/** One person and their agent. */
interface Agent {
  user: UserRow;
  client: Client;
}

describe.each(dialects)('reads in progress on %s', (dialect) => {
  let ctx: TestContext;
  let ada: Agent;
  let bob: Agent;
  let cat: Agent;
  let root: Agent;
  let id: string;
  let clients: Client[];

  async function agent(name: string, idpRole: 'admin' | 'member' = 'member'): Promise<Agent> {
    const { user } = await createSignedInUser(ctx, { kind: 'oidc', name, idpRole });
    const client = await connectMcp(ctx, { bearer: await createUserToken(ctx, user.id) });
    clients.push(client);
    return { user, client };
  }

  beforeEach(async () => {
    clients = [];
    ctx = await createTestContext({ dialect });
    ada = await agent('Ada');
    bob = await agent('Bob');
    cat = await agent('Cat');
    root = await agent('Root', 'admin');
    const { artifact } = await publishFiles(ctx, ada.user, {
      'index.html': PAGE,
      'docs/index.html': PAGE,
    });
    id = artifact.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(clients.map((client) => client.close()));
    await ctx.close();
  });

  /**
   * Holds every read of a stored file until `open` is called: a read that has taken its place
   * waits there, so the test can count who holds one (`get` is called once per read).
   */
  function holdReads() {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const read = ctx.deps.blobs.get.bind(ctx.deps.blobs);
    const get = vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (key, range) => {
      await gate;
      return read(key, range);
    });
    return { get, open };
  }

  const readFile = (who: Agent) => callText(who.client, 'read_file', { artifact_id: id });

  /** How many of the two places a person may hold are free now; it takes none of them. */
  function freePlaces(who: Agent): number {
    const taken = [tryReadSlot(ctx.deps, who.user), tryReadSlot(ctx.deps, who.user)];
    for (const release of taken) release?.();
    return taken.filter((release) => release !== null).length;
  }

  test('a third read_file at once is refused with rate_limited, before it reads anything', async () => {
    const { get, open } = holdReads();
    const held = [readFile(ada), readFile(ada)];
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    const refused = await readFile(ada);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(t('read.busy.person', { max: 2 }));
    expect(refused.text).toContain('"retry_after_seconds":3,"reason":"reads_running"');
    expect(get).toHaveBeenCalledTimes(2);

    open();
    for (const r of await Promise.all(held)) expect(r.isError, r.text).toBe(false);
    expect(freePlaces(ada)).toBe(2);
    expect((await readFile(ada)).isError).toBe(false);
  });

  test('others still read while one person holds both places, up to 4 for the instance', async () => {
    const { get, open } = holdReads();
    const held = [readFile(ada), readFile(ada)];
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    held.push(readFile(bob), readFile(bob));
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));

    const refused = await readFile(cat);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(t('read.busy.server'));
    expect(refused.text).toContain('"retry_after_seconds":3,"reason":"server_reads_busy"');
    // An admin is held to their own bound only.
    held.push(readFile(root));
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));

    open();
    for (const r of await Promise.all(held)) expect(r.isError, r.text).toBe(false);
    for (const who of [ada, bob, cat, root]) expect(freePlaces(who)).toBe(2);
  });

  test('a read that fails gives its place back', async () => {
    vi.spyOn(ctx.deps.blobs, 'get').mockRejectedValue(new Error('the disk lost it'));
    vi.spyOn(ctx.deps.logger, 'error').mockImplementation(() => {});
    const failed = await Promise.all([readFile(ada), readFile(ada)]);
    for (const r of failed) {
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain('reads_running');
    }
    expect(freePlaces(ada)).toBe(2);
  });

  test('a call the agent cancels gives its place back once its read ends', async () => {
    const { get, open } = holdReads();
    const cancel = new AbortController();
    const cancelled = ada.client.callTool(
      { name: 'read_file', arguments: { artifact_id: id } },
      undefined,
      { signal: cancel.signal },
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    cancel.abort();
    await expect(cancelled).rejects.toThrow();
    expect(freePlaces(ada)).toBe(1);

    open();
    await vi.waitFor(() => expect(freePlaces(ada)).toBe(2));
  });

  test('list_comments takes a place to locate its threads, and only then', async () => {
    const listComments = () => callText(ada.client, 'list_comments', { artifact_id: id });
    // Nothing to locate: no place is needed.
    const taken = [tryReadSlot(ctx.deps, ada.user), tryReadSlot(ctx.deps, ada.user)];
    expect((await listComments()).isError).toBe(false);

    await createThread(ctx.deps, { kind: 'member', user: bob.user }, id, {
      body: 'Sửa giá',
      anchor: sampleAnchor(),
      versionId: null,
    });
    const get = vi.spyOn(ctx.deps.blobs, 'get');
    const refused = await listComments();
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(t('read.busy.person', { max: 2 }));
    expect(refused.text).toContain('"reason":"reads_running"');
    expect(get).not.toHaveBeenCalled();

    for (const release of taken) release?.();
    const listed = await listComments();
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.text).toContain('source: docs/index.html:2 in v1');
    expect(freePlaces(ada)).toBe(2);
  });
});
