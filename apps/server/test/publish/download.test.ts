import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { revokeAllCredentials } from '../../src/auth/revoke.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { systemDeleteArtifact, systemDeleteVersion } from '../../src/domain/deletion.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { createDownloadSession, downloadCommand, runDownload } from '../../src/publish/download.ts';
import { untar, untarPaths } from '../helpers/archives.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { listen } from '../helpers/socket.ts';
import { removeMember, spacesContext, spacesFixture, UNKNOWN_IDS } from '../spaces/fixture.ts';

const T = Date.UTC(2026, 10, 18);
const URL_PATTERN = /^http:\/\/localhost:8080\/download\/[A-Za-z0-9_-]{43}$/;

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** The path of a download URL, for a request through the app. */
const pathOf = (url: string) => new URL(url).pathname;

/** What every URL that cannot be used answers: it must not tell why. */
const UNKNOWN = { code: 'not_found', message: t('download.session.unknown') };

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const { error } = (await res.json()) as ErrorJson;
  return { code: error.code, message: error.message };
}

describe('downloadCommand', () => {
  test('the command quotes a directory with spaces', () => {
    expect(downloadCommand('https://p/download/t', './my site')).toBe(
      `mkdir -p './my site' && curl --fail-with-body -sS "https://p/download/t" | tar -xzf - -C './my site'`,
    );
  });

  test('a directory of safe characters stays as it is, and a quote is escaped', () => {
    expect(downloadCommand('https://p/download/t', './pinwall-art_1')).toBe(
      'mkdir -p ./pinwall-art_1 && curl --fail-with-body -sS "https://p/download/t" | tar -xzf - -C ./pinwall-art_1',
    );
    expect(downloadCommand('https://p/download/t', "./it's")).toContain(`'./it'\\''s'`);
  });
});

describe.each(dialects)('download sessions on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let id: string;
  let v1: string;

  async function start(log?: (line: string) => void): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, ...(log === undefined ? {} : { log }) });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    const first = await publishFiles(ctx, ada.user, {
      'index.html': '<link rel="stylesheet" href="css/site.css"><p>Một</p>',
      'css/site.css': 'p { color: red }',
    });
    id = first.artifact.id;
    v1 = first.version.id;
  }
  afterEach(() => ctx.close());

  /** Publishes the next version of the artifact. */
  const publishNext = async (files: Record<string, string | Buffer>, expected: string) =>
    (
      await publishFiles(ctx, ada.user, files, {
        kind: 'new_version',
        artifactId: id,
        expectedVersionId: expected,
      })
    ).version;

  const get = (url: string, init?: RequestInit) => ctx.request(pathOf(url), init);

  test('the URL downloads the version as tar.gz once', async () => {
    await start();
    const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    expect(s.url).toMatch(URL_PATTERN);

    const first = await get(s.url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/gzip');
    expect(first.headers.get('content-disposition')).toBe(
      `attachment; filename="pinwall-${id}-v1.tar.gz"`,
    );
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    const files = await untar(first);
    expect(files.map((f) => f.path)).toEqual(['css/site.css', 'index.html']);
    expect(files.map((f) => f.body.toString('utf8'))).toEqual([
      'p { color: red }',
      '<link rel="stylesheet" href="css/site.css"><p>Một</p>',
    ]);

    const second = await get(s.url);
    expect(second.status).toBe(404);
    expect(await errorOf(second)).toEqual(UNKNOWN);
  });

  test('it holds the current version unless one is named, and says which', async () => {
    await start();
    const v2 = await publishNext({ 'index.html': '<p>Hai</p>' }, v1);

    const current = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    expect(current.version).toEqual({ id: v2.id, number: 2 });
    const older = await createDownloadSession(ctx.deps, ada.user, { artifactId: id, version: 1 });
    expect(older.version).toEqual({ id: v1, number: 1 });

    const a = await get(current.url);
    expect(a.headers.get('content-disposition')).toContain(`pinwall-${id}-v2.tar.gz`);
    expect(await untarPaths(a)).toEqual(['index.html']);
    const b = await get(older.url);
    expect(b.headers.get('content-disposition')).toContain(`pinwall-${id}-v1.tar.gz`);
    expect(await untarPaths(b)).toEqual(['css/site.css', 'index.html']);
  });

  test('the command unpacks into ./pinwall-<id> unless a directory is given', async () => {
    await start();
    const plain = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    expect(plain.command).toBe(downloadCommand(plain.url, `./pinwall-${id}`));
    const spaced = await createDownloadSession(ctx.deps, ada.user, {
      artifactId: id,
      directory: './my site',
    });
    expect(spaced.command).toBe(downloadCommand(spaced.url, './my site'));
    expect(spaced.command).toContain(`-C './my site'`);
  });

  test('only the hash of the token is kept, in the user group, for the session TTL', async () => {
    await start();
    const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    const token = pathOf(s.url).split('/').pop() ?? '';
    expect(await ctx.deps.oneTime.peek(`download:${token}`)).toBeNull();
    expect(await ctx.deps.oneTime.peek(`download:${hashSecret(token)}`)).toEqual({
      actorId: ada.user.id,
      versionId: v1,
      artifactId: id,
    });
    expect(s.expiresAt).toBe(T + ctx.deps.config.ttl.uploadSessionMs);
    expect(await ctx.deps.oneTime.deleteGroup(`upload-user:${ada.user.id}`)).toBe(1);
  });

  test('an unknown, used or expired URL answers alike: 404 with how to get a new one', async () => {
    await start();
    expect(UNKNOWN.message).toContain('create_download_session');
    const unknown = await ctx.request(`/download/${'a'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual(UNKNOWN);

    const expired = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    clock.advance(ctx.deps.config.ttl.uploadSessionMs + 1);
    const late = await get(expired.url);
    expect(late.status).toBe(404);
    expect(await errorOf(late)).toEqual(UNKNOWN);
  });

  test('errors are JSON even for a browser', async () => {
    await start();
    const res = await ctx.request(`/download/${'a'.repeat(43)}`, {
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('Revoke now ends an unused download URL', async () => {
    await start();
    const other = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });
    const otherPublish = await publishFiles(ctx, other.user, { 'index.html': '<p>x</p>' });
    const first = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    const second = await createDownloadSession(ctx.deps, ada.user, { artifactId: id, version: 1 });
    const kept = await createDownloadSession(ctx.deps, other.user, {
      artifactId: otherPublish.artifact.id,
    });

    await revokeAllCredentials(ctx.deps, ada.user.id);
    for (const s of [first, second]) {
      const r = await get(s.url);
      expect(r.status).toBe(404);
      expect(await errorOf(r)).toEqual(UNKNOWN);
    }
    // Another user's URL is untouched, and the user can get a new one.
    expect((await get(kept.url)).status).toBe(200);
    const fresh = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    expect((await get(fresh.url)).status).toBe(200);
  });

  test('the URL reads no cookie and no Authorization header', async () => {
    await start();
    const stranger = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });
    const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    const r = await get(s.url, {
      headers: { cookie: stranger.cookie, authorization: 'Bearer not-a-token' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.has('set-cookie')).toBe(false);
    expect(await untarPaths(r)).toEqual(['css/site.css', 'index.html']);
  });

  test('a HEAD request does not use the URL up', async () => {
    await start();
    const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    const head = await get(s.url, { method: 'HEAD' });
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    expect((await get(s.url)).status).toBe(200);
  });

  test('files keep their bytes and paths, whatever the name or size', async () => {
    await start();
    const binary = randomBytes(70_000);
    const long = `${'thư-mục/'.repeat(14)}tệp.txt`;
    const v2 = await publishNext(
      {
        'index.html': '<p>x</p>',
        'img/a.bin': binary,
        'empty.txt': '',
        'tài liệu/ghi chú.md': 'Một\n',
        [long]: 'dài',
      },
      v1,
    );
    expect(long.length).toBeGreaterThan(100);
    const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    expect(s.version.id).toBe(v2.id);

    const files = await untar(await get(s.url));
    expect(files.map((f) => f.path)).toEqual(
      ['empty.txt', 'img/a.bin', 'index.html', long, 'tài liệu/ghi chú.md'].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    );
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('img/a.bin')?.body.equals(binary)).toBe(true);
    expect(byPath.get('empty.txt')?.body.length).toBe(0);
    expect(byPath.get(long)?.body.toString('utf8')).toBe('dài');
    expect(byPath.get('tài liệu/ghi chú.md')?.body.toString('utf8')).toBe('Một\n');
    expect(files.every((f) => f.type === 'file')).toBe(true);
  });

  describe('the stream', () => {
    /** A version of five files of 300 KB that gzip cannot shrink, and a session for it. */
    async function bigVersion(): Promise<{ token: string; shas: string[] }> {
      const files: Record<string, Buffer> = { 'index.html': Buffer.from('<p>x</p>') };
      for (let i = 0; i < 4; i++) files[`f${i}.bin`] = randomBytes(300_000);
      await publishNext(files, v1);
      const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
      const rows = await ctx.deps.db.db
        .selectFrom('version_files')
        .select(['path', 'sha256'])
        .where('version_id', '=', s.version.id)
        .orderBy('path')
        .execute();
      return { token: pathOf(s.url).split('/').pop() ?? '', shas: rows.map((r) => r.sha256) };
    }

    test('a blob is read as the client takes the archive, not all at once', async () => {
      await start();
      const chunk = 64 * 1024;
      const chunks = 40;
      await publishNext({ 'index.html': Buffer.alloc(chunk * chunks) }, v1);
      const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
      // The store gives the bytes the version lists, a chunk at a time, and counts what is asked.
      let pulled = 0;
      vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(
        async () =>
          new Readable({
            highWaterMark: chunk,
            read() {
              if (pulled < chunks) {
                pulled += 1;
                this.push(randomBytes(chunk));
              } else {
                this.push(null);
              }
            },
          }),
      );

      const { body } = await runDownload(ctx.deps, pathOf(s.url).split('/').pop() ?? '');
      const taken = body[Symbol.asyncIterator]();
      await taken.next();
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The client has taken one chunk: the pipeline holds a few buffers, not the file.
      expect(pulled).toBeLessThan(chunks / 4);

      let total = 0;
      for (let next = await taken.next(); next.done !== true; next = await taken.next()) {
        total += (next.value as Buffer).length;
      }
      expect(total).toBeGreaterThan(chunk * chunks);
      expect(pulled).toBe(chunks);
    });

    test('a client that goes away closes the blob it was reading', async () => {
      await start();
      const { token } = await bigVersion();
      const opened: Readable[] = [];
      const original = ctx.deps.blobs.get.bind(ctx.deps.blobs);
      vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (sha, range) => {
        const stream = await original(sha, range);
        opened.push(stream);
        return stream;
      });

      const { body } = await runDownload(ctx.deps, token);
      await body[Symbol.asyncIterator]().next();
      body.destroy();
      await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(opened.every((stream) => stream.destroyed)).toBe(true));
      // It reads no further.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(opened.length).toBeLessThan(5);
    });

    test('a blob that fails mid-archive fails the stream, and logs no URL', async () => {
      const lines: string[] = [];
      await start((line) => lines.push(line));
      const { token, shas } = await bigVersion();
      const original = ctx.deps.blobs.get.bind(ctx.deps.blobs);
      vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (sha, range) => {
        if (sha !== shas[2]) return original(sha, range);
        let sent = false;
        return new Readable({
          read() {
            if (sent) this.destroy(new Error('disk gone'));
            else this.push(randomBytes(1000));
            sent = true;
          },
        });
      });

      const { body } = await runDownload(ctx.deps, token);
      await expect(
        (async () => {
          for await (const _ of body) {
            // Taking it all.
          }
        })(),
      ).rejects.toThrow('disk gone');
      expect(lines.some((line) => line.includes(token))).toBe(false);
    });

    test('over HTTP a failure ends the response without its end, so curl and tar fail', async () => {
      await start();
      const { token, shas } = await bigVersion();
      const original = ctx.deps.blobs.get.bind(ctx.deps.blobs);
      vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (sha, range) => {
        if (sha !== shas[3]) return original(sha, range);
        throw new Error('disk gone');
      });
      // The server writes what it cannot answer to the console; the test reads it from the client.
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const server = await listen(ctx.app, ctx.deps.config);
      try {
        const received = await new Promise<{ bytes: Buffer; complete: boolean; error: boolean }>(
          (resolve) => {
            const req = httpRequest({
              host: '127.0.0.1',
              port: server.port,
              path: `/download/${token}`,
            });
            req.on('response', (res) => {
              const parts: Buffer[] = [];
              let error = false;
              res.on('data', (part: Buffer) => parts.push(part));
              res.on('error', () => {
                error = true;
              });
              res.on('close', () =>
                resolve({ bytes: Buffer.concat(parts), complete: res.complete, error }),
              );
            });
            req.on('error', () =>
              resolve({ bytes: Buffer.alloc(0), complete: false, error: true }),
            );
            req.end();
          },
        );
        expect(received.complete).toBe(false);
        expect(received.error).toBe(true);
        // What did arrive is not a whole gzip stream: tar refuses it too.
        expect(() => gunzipSync(received.bytes)).toThrow();
      } finally {
        await server.close();
      }
    });
  });

  test('logs never hold the URL, whether it worked or not', async () => {
    const lines: string[] = [];
    await start((line) => lines.push(line));
    const s = await createDownloadSession(ctx.deps, ada.user, { artifactId: id });
    const token = pathOf(s.url).split('/').pop() ?? '';
    await get(s.url);
    await get(s.url);
    await ctx.request(`/download/${'b'.repeat(43)}`);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain('b'.repeat(43));
    }
    expect(lines.some((line) => line.includes('/download/:token'))).toBe(true);
  });
});

describe.each(dialects)('download sessions in personal spaces on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  async function start() {
    ctx = await spacesContext(dialect, 'personal');
    return spacesFixture(ctx);
  }

  const get = (url: string) => ctx.request(pathOf(url));

  test('another space answers not_found at creation, as for an id that does not exist', async () => {
    const fx = await start();
    const { S } = fx.people;
    const refusal = async (artifactId: string) => {
      const error = await createDownloadSession(ctx.deps, S.user, { artifactId }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AppError);
      const { code, status, message } = error as AppError;
      return { code, status, message };
    };
    const outsider = await refusal(fx.ids.p);
    expect(outsider.code).toBe('not_found');
    expect(outsider).toEqual(await refusal(UNKNOWN_IDS.p));
    // A stranger gets the same for a version number the artifact never had.
    await expect(
      createDownloadSession(ctx.deps, fx.people.A.user, { artifactId: fx.ids.p, version: 9 }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('a viewer may download', async () => {
    const fx = await start();
    const s = await createDownloadSession(ctx.deps, fx.people.V.user, { artifactId: fx.ids.p });
    const r = await get(s.url);
    expect(r.status).toBe(200);
    // The fixture's second version.
    expect(await untarPaths(r)).toEqual(['cover.png', 'index.html', 'notes.md']);
  });

  describe('a user who lost access gets 404 from the URL', () => {
    /** A session of the viewer V for the artifact p, made while V still had access. */
    async function sessionOfViewer(version?: number) {
      const fx = await start();
      const s = await createDownloadSession(ctx.deps, fx.people.V.user, {
        artifactId: fx.ids.p,
        ...(version === undefined ? {} : { version }),
      });
      return { fx, s };
    }

    async function expectUnknown(url: string) {
      const r = await get(url);
      expect(r.status).toBe(404);
      expect(await errorOf(r)).toEqual(UNKNOWN);
    }

    test('they were blocked', async () => {
      const { fx, s } = await sessionOfViewer();
      await ctx.deps.db.db
        .updateTable('users')
        .set({ role_override: 'blocked' })
        .where('id', '=', fx.people.V.user.id)
        .execute();
      await expectUnknown(s.url);
    });

    test('they were disabled', async () => {
      const { fx, s } = await sessionOfViewer();
      await ctx.deps.db.db
        .updateTable('users')
        .set({ disabled_at: T })
        .where('id', '=', fx.people.V.user.id)
        .execute();
      await expectUnknown(s.url);
    });

    test('they left the project', async () => {
      const { fx, s } = await sessionOfViewer();
      await removeMember(ctx, fx.ids.P, fx.people.V.user.id);
      await expectUnknown(s.url);
    });

    test('the artifact was deleted: not "gone", which would say it existed', async () => {
      const { fx, s } = await sessionOfViewer();
      await systemDeleteArtifact(ctx.deps, SYSTEM_SCOPE, fx.ids.p);
      await expectUnknown(s.url);
    });

    test('the version was deleted', async () => {
      const { fx, s } = await sessionOfViewer(1);
      await systemDeleteVersion(ctx.deps, SYSTEM_SCOPE, fx.ids.p, 1);
      await expectUnknown(s.url);
    });
  });
});
