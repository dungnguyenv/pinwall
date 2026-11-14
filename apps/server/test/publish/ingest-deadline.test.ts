import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PublishSession } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { t } from '../../src/lib/i18n.ts';
import { ingestDeadlineMs, takeIngestSlot } from '../../src/publish/ingest-slots.ts';
import { makeTar } from '../helpers/archives.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import { listen, socketPost } from '../helpers/socket.ts';
import type { Person } from '../spaces/fixture.ts';

test('a publish may hold its place for 10 minutes, or for its largest upload at 64 KiB/s', async () => {
  expect(ingestDeadlineMs(1_000_000)).toBe(600_000);
  // 37.5 MiB at 64 KiB/s is exactly 10 minutes.
  expect(ingestDeadlineMs(39_321_600)).toBe(600_000);
  // 50 MiB takes 800 s, and the default of 95 MB a little over 24 minutes.
  expect(ingestDeadlineMs(52_428_800)).toBe(800_000);
  expect(ingestDeadlineMs(95_000_000)).toBe(1_449_585);

  const ctx = await createTestContext({ env: { PINWALL_MAX_UPLOAD_BYTES: '104857600' } });
  try {
    expect(ctx.deps.ingestDeadlineMs).toBe(1_600_000);
  } finally {
    await ctx.close();
  }
});

/** How long the tests below let a publish hold its place. */
const DEADLINE_MS = 400;

/** The 408 of a publish stopped at its deadline (`DEADLINE_MS` rounds up to a second, a minute). */
const TIMED_OUT = {
  error: {
    code: 'request_timeout',
    message: t('publish.deadline', { minutes: 1 }),
    details: { reason: 'publish_deadline', deadline_seconds: 1 },
  },
};

const PAGE = '<!doctype html><p>Kept</p>';
const BOUNDARY = 'pinwall-deadline-form';

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A request body that sends `head` at once, then one byte every 50 ms, and never ends: a client
 * that never stalls long enough for the idle timeout. `stop` ends the trickle when the server did
 * not cancel the stream.
 */
function trickle(head: Buffer): { body: ReadableStream<Uint8Array>; stop(): void } {
  let timer: NodeJS.Timeout | undefined;
  const stop = () => clearInterval(timer);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(head));
      timer = setInterval(() => controller.enqueue(new Uint8Array([0x41])), 50);
    },
    cancel: stop,
  });
  return { body, stop };
}

describe.each(dialects)('how long a publish may hold its place, on %s', (dialect) => {
  let ctx: TestContext;
  let ada: Person;
  let bob: Person;
  /** Ada's artifact with one version, to restore. */
  let adaArtifact: { id: string; versionId: string };

  async function person(name: string): Promise<Person> {
    const { user, cookie } = await createSignedInUser(ctx, { kind: 'oidc', name });
    return { user, cookie, token: await createUserToken(ctx, user.id) };
  }

  beforeEach(async () => {
    ctx = await createTestContext({ dialect });
    ctx.deps.ingestDeadlineMs = DEADLINE_MS;
    ada = await person('Ada');
    bob = await person('Bob');
    const { artifact, version } = await publishFiles(ctx, ada.user, { 'index.html': PAGE });
    adaArtifact = { id: artifact.id, versionId: version.id };
  });
  afterEach(() => ctx.close());

  /**
   * Whether every place is free: Ada's two, and with Bob's two the instance's four. Takes them
   * and gives them back.
   */
  function everyPlaceFree(): boolean {
    const taken: (() => void)[] = [];
    try {
      for (const who of [ada, ada, bob, bob]) taken.push(takeIngestSlot(ctx.deps, who.user));
      return true;
    } catch {
      return false;
    } finally {
      for (const release of taken) release();
    }
  }

  /** What the publish left behind: versions, blobs (rows and objects) and temporary files. */
  async function leftovers() {
    const objects: string[] = [];
    for await (const key of ctx.deps.blobs.list()) objects.push(key);
    const { storage } = ctx.deps.config;
    const tmp = storage.kind === 'local' ? join(storage.dir, 'tmp') : null;
    return {
      versions: (await ctx.deps.db.db.selectFrom('versions').select('id').execute()).length,
      blobs: (await ctx.deps.db.db.selectFrom('blobs').select('sha256').execute()).length,
      objects: objects.sort(),
      tmp: tmp === null ? [] : await readdir(tmp).catch(() => []),
    };
  }

  /** A fresh upload URL of Ada's, as a path. */
  async function uploadPath(): Promise<string> {
    const made = await restClient(ctx, ada.cookie).post('/publish-sessions', { target: {} });
    expect(made.status).toBe(201);
    return new URL(PublishSession.parse(made.body).upload_url).pathname;
  }

  const post = (path: string, body: ReadableStream<Uint8Array> | string, contentType: string) =>
    ctx.request(path, {
      method: 'POST',
      body,
      headers: { 'content-type': contentType },
      ...(typeof body === 'string' ? {} : { duplex: 'half' }),
    } as RequestInit);

  /**
   * Runs a publish whose client keeps sending (`trickle`), so only the deadline can end it, and
   * checks that it held a place while it ran and that it ends 408, with every place back and
   * nothing kept.
   */
  async function trickledPastTheDeadline(send: () => Promise<Response>): Promise<void> {
    const before = await leftovers();
    const spooled = vi.spyOn(ctx.deps.blobs, 'spool');
    const answer = send();
    await vi.waitFor(() => expect(spooled).toHaveBeenCalled());
    expect(everyPlaceFree()).toBe(false);
    const res = await answer;
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 408,
      body: TIMED_OUT,
    });
    expect(everyPlaceFree()).toBe(true);
    expect(await leftovers()).toEqual(before);
    spooled.mockRestore();
  }

  test('an upload URL whose client trickles its body ends 408 at the deadline, and keeps nothing', async () => {
    const path = await uploadPath();
    // a.css arrives whole and is stored; b.bin's data trickles in.
    const tar = await makeTar([
      { name: 'a.css', body: 'p{color:red}' },
      { name: 'b.bin', body: Buffer.alloc(65_536, 0x41) },
    ]);
    const { body, stop } = trickle(tar.subarray(0, 1536 + 100));
    try {
      await trickledPastTheDeadline(() => post(path, body, 'application/x-tar'));
    } finally {
      stop();
    }
    // The failed upload handed its URL back.
    expect((await post(path, PAGE, 'text/html')).status).toBe(201);
  });

  test('a web upload whose client trickles its form ends 408 at the deadline, and keeps nothing', async () => {
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="target"\r\n\r\n{}\r\n` +
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="index.html"\r\n` +
        'Content-Type: text/html\r\n\r\n<p>',
    );
    const { body, stop } = trickle(head);
    try {
      await trickledPastTheDeadline(() =>
        ctx.request('/api/v1/publish/upload', {
          method: 'POST',
          body,
          duplex: 'half',
          headers: {
            cookie: ada.cookie,
            origin: ctx.deps.config.publicOrigin,
            'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
        } as RequestInit),
      );
    } finally {
      stop();
    }
  });

  /**
   * Holds the publish that `start` begins inside `gated` (a spy that waits for the gate), checks
   * that its place comes back once the deadline passes although the publish still waits, then
   * opens the gate and returns how the publish ended.
   */
  async function heldPastTheDeadline<T>(
    method: 'put' | 'get',
    start: () => Promise<T>,
  ): Promise<{ outcome: T; before: Awaited<ReturnType<typeof leftovers>> }> {
    const before = await leftovers();
    const reached = deferred();
    const gate = deferred();
    const original = ctx.deps.blobs[method].bind(ctx.deps.blobs) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = vi.spyOn(ctx.deps.blobs, method).mockImplementation((async (...args: unknown[]) => {
      reached.resolve();
      await gate.promise;
      return original(...args);
    }) as never);
    try {
      const running = start();
      await reached.promise;
      expect(everyPlaceFree()).toBe(false);
      await vi.waitFor(() => expect(everyPlaceFree()).toBe(true), { timeout: 5 * DEADLINE_MS });
      gate.resolve();
      return { outcome: await running, before };
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }

  test('an inline publish over REST that runs past the deadline gives its place back and ends 408', async () => {
    const { outcome, before } = await heldPastTheDeadline('put', () =>
      restClient(ctx, ada.cookie).post('/publish/inline', {
        target: {},
        files: [{ path: 'index.html', content: '<p>Slow to store</p>' }],
      }),
    );
    expect({ status: outcome.status, body: outcome.body }).toEqual({
      status: 408,
      body: TIMED_OUT,
    });
    expect(await leftovers()).toEqual(before);
  });

  test('an inline publish over MCP that runs past the deadline gives its place back and fails', async () => {
    const agent = await connectMcp(ctx, { bearer: ada.token });
    try {
      const { outcome, before } = await heldPastTheDeadline(
        'put',
        async () =>
          (await agent.callTool({
            name: 'publish_inline',
            arguments: { files: [{ path: 'index.html', content: '<p>Slow to store</p>' }] },
          })) as CallToolResult,
      );
      expect(outcome.isError).toBe(true);
      expect(toolText(outcome)).toContain(t('publish.deadline', { minutes: 1 }));
      expect(await leftovers()).toEqual(before);
    } finally {
      await agent.close();
    }
  });

  test('a restore that runs past the deadline gives its place back and ends 408', async () => {
    // The restore reads the old version's text from its blobs before it copies the version.
    const { outcome, before } = await heldPastTheDeadline('get', () =>
      restClient(ctx, ada.cookie).post(`/artifacts/${adaArtifact.id}/versions/1/restore`, {
        expected_version_id: adaArtifact.versionId,
      }),
    );
    expect({ status: outcome.status, body: outcome.body }).toEqual({
      status: 408,
      body: TIMED_OUT,
    });
    expect(await leftovers()).toEqual(before);
  });

  test('a web upload whose client stalls ends 408 at the idle timeout and gives its place back', async () => {
    const server = await listen(buildApp(ctx.deps, { uploadIdleTimeoutMs: 500 }), ctx.deps.config);
    // The idle timeout ends it, long before the deadline does.
    ctx.deps.ingestDeadlineMs = 60_000;
    const before = await leftovers();
    const spooled = vi.spyOn(ctx.deps.blobs, 'spool');
    try {
      const reply = socketPost(server.port, '/api/v1/publish/upload', {
        headers: {
          cookie: ada.cookie,
          origin: ctx.deps.config.publicOrigin,
          'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
          'transfer-encoding': 'chunked',
        },
        chunks: [
          Buffer.from(
            `--${BOUNDARY}\r\nContent-Disposition: form-data; name="target"\r\n\r\n{}\r\n` +
              `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="index.html"\r\n` +
              'Content-Type: text/html\r\n\r\n<p>half a page',
          ),
        ],
        stall: true,
      });
      await vi.waitFor(() => expect(spooled).toHaveBeenCalled());
      expect(everyPlaceFree()).toBe(false);
      const { status, json } = await reply;
      expect({ status, json }).toEqual({
        status: 408,
        json: {
          error: {
            code: 'request_timeout',
            message: t('publish.webUpload.idle', { seconds: 1 }),
            details: { idle_timeout_seconds: 1 },
          },
        },
      });
    } finally {
      spooled.mockRestore();
      await server.close();
    }
    expect(everyPlaceFree()).toBe(true);
    expect(await leftovers()).toEqual(before);
  });
});
