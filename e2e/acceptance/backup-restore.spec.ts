import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  type Container,
  composeUp,
  removeContainers,
  runImage,
  waitForSetupUrl,
} from '../support/docker.ts';
import {
  type Api,
  apiClient,
  type Published,
  publishSite,
  setupAndSignIn,
  signIn,
} from '../support/node-api.ts';

/*
 * Acceptance 6: a backup of an install on SQLite and local disk, restored into the Postgres + S3
 * Compose example, keeps everything: accounts, tokens, artifacts, every byte of every file,
 * search, comments and share links.
 */

const image = process.env.PINWALL_ACCEPTANCE_IMAGE || 'pinwall:acceptance';
const id = randomBytes(4).toString('hex');
const SOURCE = { name: `pinwall-acc-a-${id}`, volume: `pinwall-acc-a-${id}`, port: 18121 };
const TARGET = { project: `pinwall-acc-b-${id}`, port: 18120 };
const TARGET_ORIGIN = `http://localhost:${TARGET.port}`;
const COMPOSE_FILE = 'deploy/compose/docker-compose.postgres-s3.yml';
// The example's services, pinned by digest for this run (the example names them by tag).
const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:e5d2edd28b1f8d40a0a6c0c9cdc545b19b56a0d5d88f94bc11a97d970d4700d0';
const SILO_IMAGE =
  'pgsty/silo:RELEASE.2026-11-09T00-00-00Z@sha256:08ce1505b5eacefbad1ca07159b242b9ce045a11c2817e3bc257b25f77bbc02d';

const PASSWORD = 'correct horse battery staple';
const SHARE_PASSWORD = 'Mật khẩu chia sẻ';

let source: Container | undefined;
let target: Awaited<ReturnType<typeof composeUp>> | undefined;
let secretsDir: string | undefined;

test.afterAll(async () => {
  await target?.down();
  await removeContainers([SOURCE.name], [SOURCE.volume]);
  if (secretsDir !== undefined) await rm(secretsDir, { recursive: true, force: true });
});

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A PNG chunk: length, type, data, CRC of type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid `size`×`size` RGB PNG of random pixels: a binary file with every byte value. */
function randomPng(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit depth, RGB, deflate, no filter method, no interlace
  const rows = Array.from({ length: size }, () =>
    Buffer.concat([Buffer.from([0]), randomBytes(size * 3)]),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The name of the first entry of a tar archive (its first header's name field). */
function firstTarEntry(archive: Buffer): string {
  expect(archive.subarray(257, 262).toString('latin1')).toBe('ustar');
  return archive.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
}

interface ArtifactSummary {
  id: string;
  name: string;
  tags: string[];
  latest_number: number;
  current_version: { number: number } | null;
}

/** What must survive the move: each artifact's name, tags and version numbers, by id. */
async function library(api: Api) {
  const list = await api.call<{ items: ArtifactSummary[] }>('GET', '/api/v1/artifacts');
  expect(list.status).toBe(200);
  const artifacts = [];
  for (const a of [...list.json.items].sort((x, y) => x.id.localeCompare(y.id))) {
    const versions = await api.call<{ items: { number: number }[] }>(
      'GET',
      `/api/v1/artifacts/${a.id}/versions`,
    );
    artifacts.push({
      id: a.id,
      name: a.name,
      tags: a.tags,
      latest: a.latest_number,
      current: a.current_version?.number ?? null,
      versions: versions.json.items.map((v) => v.number).sort((x, y) => x - y),
    });
  }
  return artifacts;
}

/** The files of version `n`, as the API lists them: path and SHA-256. */
async function versionFiles(api: Api, artifactId: string, n: number) {
  const files = await api.call<{ items: { path: string; sha256: string }[] }>(
    'GET',
    `/api/v1/artifacts/${artifactId}/versions/${n}/files`,
  );
  expect(files.status).toBe(200);
  return files.json.items.map((f) => ({ path: f.path, sha256: f.sha256 }));
}

/** The grant a raw link redirects to. */
async function grantOf(api: Api, link: string): Promise<URL> {
  const raw = await api.call('GET', link, undefined, { accept: '*/*' });
  expect(raw.status, link).toBe(302);
  return new URL(raw.headers.get('location') ?? '', api.origin);
}

const fetchBytes = async (url: URL, headers: Record<string, string> = {}) => {
  const response = await fetch(url, { headers });
  expect(response.status, url.pathname).toBe(200);
  return Buffer.from(await response.arrayBuffer());
};

/** Writes the five secret files the Compose example reads, freshly generated, as its header does. */
async function writeSecrets(dir: string): Promise<void> {
  const postgresPassword = randomBytes(24).toString('hex');
  const secrets = {
    'postgres-password': postgresPassword,
    'database-url': `postgres://pinwall:${postgresPassword}@postgres:5432/pinwall`,
    'secret-key': randomBytes(32).toString('hex'),
    's3-access-key-id': randomBytes(8).toString('hex'),
    's3-secret-access-key': randomBytes(24).toString('hex'),
  };
  for (const [name, value] of Object.entries(secrets)) {
    await writeFile(join(dir, name), value);
    // Readable by the non-root users inside the containers; the folder itself is private.
    await chmod(join(dir, name), 0o444);
  }
}

test('6: a SQLite + local-disk backup restores into Postgres + S3 with everything present', async () => {
  test.setTimeout(420_000);
  const photo = randomPng(48);
  const pages = {
    v1: '<!doctype html><meta charset="utf-8"><title>Lịch chụp ảnh cưới</title><h1>Dịch vụ chụp ảnh</h1><img src="img/photo.png">',
    v2: '<!doctype html><meta charset="utf-8"><title>Lịch chụp ảnh cưới</title><h1>Dịch vụ chụp ảnh cưới</h1><img src="img/photo.png"><a href="docs/bang-gia.html">Bảng giá</a>',
    prices: '<!doctype html><meta charset="utf-8"><p>Giá trọn gói: 12.000.000 đồng</p>',
  };
  const v2Files: Record<string, string | Buffer> = {
    'index.html': pages.v2,
    'img/photo.png': photo,
    'docs/bang-gia.html': pages.prices,
  };

  // 1. Source A: the default install, SQLite and local disk, with some history.
  let api!: Api;
  let v1!: Published;
  let threadId!: string;
  let shareToken!: string;
  let apiToken!: string;
  await test.step('set up the source on SQLite and local disk', async () => {
    source = await runImage({ image, ...SOURCE });
    api = await setupAndSignIn(source.origin, await waitForSetupUrl(source, 120_000), PASSWORD);
    v1 = await publishSite(
      api,
      { 'index.html': pages.v1, 'img/photo.png': photo },
      { name: 'Lịch chụp ảnh cưới', tags: ['ảnh cưới', 'acceptance'] },
    );
    const thread = await api.call<{ id: string }>(
      'POST',
      `/api/v1/artifacts/${v1.artifact_id}/comments`,
      {
        body: 'Thêm bảng giá',
        version_id: v1.version_id,
        anchor: {
          page: 'index.html',
          kind: 'text',
          quote: { exact: 'chụp ảnh', prefix: 'Dịch vụ ', suffix: '' },
          dom: { path: 'body > h1' },
          position: { x: 0.1, y: 0.05 },
          viewport: { width: 1280 },
        },
      },
    );
    expect(thread.status).toBe(201);
    threadId = thread.json.id;
    const reply = await api.call('POST', `/api/v1/comments/${threadId}/replies`, {
      body: 'Đã thêm ở bản 2',
    });
    expect(reply.status).toBe(201);
    const v2 = await publishSite(api, v2Files, {
      artifact_id: v1.artifact_id,
      expected_version_id: v1.version_id,
    });
    expect(v2.version_number).toBe(2);
    const resolved = await api.call<{ resolved_in_version: { number: number } | null }>(
      'POST',
      `/api/v1/comments/${threadId}/resolve`,
      {},
    );
    expect(resolved.json.resolved_in_version?.number).toBe(2);
    const share = await api.call<{ token: string }>(
      'POST',
      `/api/v1/artifacts/${v1.artifact_id}/share-links`,
      { password: SHARE_PASSWORD },
    );
    expect(share.status).toBe(201);
    shareToken = share.json.token;
    const token = await api.call<{ secret: string }>('POST', '/api/v1/me/tokens', {
      name: 'acceptance',
    });
    expect(token.status).toBe(201);
    apiToken = token.json.secret;
  });
  const sourceLibrary = await library(api);
  const sourceFiles = await versionFiles(api, v1.artifact_id, 2);
  expect(sourceFiles.map((f) => f.path).sort()).toEqual(Object.keys(v2Files).sort());

  // 2. The backup, to standard output.
  let archive!: Buffer;
  await test.step('back up the source to standard output', async () => {
    const backup = await source?.exec(['pinwall', 'backup', '--out', '-']);
    expect(backup?.code, backup?.stderr).toBe(0);
    archive = backup?.stdout ?? Buffer.alloc(0);
    expect(firstTarEntry(archive)).toBe('manifest.json');
  });

  // 3. Target B: the Postgres + S3 Compose example with fresh secrets.
  await test.step('bring up the Postgres + S3 example as the target', async () => {
    secretsDir = await mkdtemp(join(tmpdir(), 'pinwall-acc-secrets-'));
    await writeSecrets(secretsDir);
    target = await composeUp({
      file: COMPOSE_FILE,
      project: TARGET.project,
      env: {
        PINWALL_IMAGE: image,
        PINWALL_PORT_PUBLISHED: String(TARGET.port),
        PINWALL_PUBLIC_ORIGIN: TARGET_ORIGIN,
        PINWALL_SECRETS_DIR: secretsDir,
      },
      images: { postgres: POSTGRES_IMAGE, minio: SILO_IMAGE, 'minio-init': SILO_IMAGE },
    });
  });

  // 4. The restore, from standard input.
  await test.step('restore the archive into the target', async () => {
    const restored = await target?.exec(['pinwall', 'restore', '--in', '-'], { stdin: archive });
    expect(restored?.code, restored?.stderr).toBe(0);
    expect(restored?.stderr).toContain('restore complete');
  });

  // 5. Everything is there.
  await test.step('find everything on the target', async () => {
    const owner = await signIn(TARGET_ORIGIN, PASSWORD);
    const me = await apiClient(TARGET_ORIGIN, { bearer: apiToken }).call<{ via: string }>(
      'GET',
      '/api/v1/me',
    );
    expect(me.status).toBe(200);
    expect(me.json.via).toBe('api_token');

    expect(await library(owner)).toEqual(sourceLibrary);
    expect(await versionFiles(owner, v1.artifact_id, 2)).toEqual(sourceFiles);
    const grant = await grantOf(owner, `/a/${v1.artifact_id}/v/2/raw`);
    for (const [path, content] of Object.entries(v2Files)) {
      expect(sha256(await fetchBytes(new URL(path, grant))), path).toBe(sha256(content));
    }

    const found = await owner.call<{ items: { id: string }[] }>(
      'GET',
      '/api/v1/artifacts?q=chup%20anh',
    );
    expect(found.json.items.map((item) => item.id)).toContain(v1.artifact_id);

    const threads = await owner.call<{
      items: {
        id: string;
        version: { number: number };
        status: string;
        resolved_in_version: { number: number } | null;
        replies: { body: string }[];
      }[];
    }>('GET', `/api/v1/artifacts/${v1.artifact_id}/comments?status=all`);
    expect(threads.json.items.find((t) => t.id === threadId)).toMatchObject({
      version: { number: 1 },
      status: 'resolved',
      resolved_in_version: { number: 2 },
      replies: [{ body: 'Đã thêm ở bản 2' }],
    });

    // The share link is locked until its password is given, then serves the page.
    const visitor = apiClient(TARGET_ORIGIN, {});
    const locked = await visitor.call<{ error: { details?: { password_required?: boolean } } }>(
      'GET',
      `/api/v1/share/${shareToken}`,
    );
    expect(locked.status).toBe(401);
    expect(locked.json.error.details?.password_required).toBe(true);
    const page = await visitor.call('GET', `/s/${shareToken}`, undefined, { accept: 'text/html' });
    expect(page.status).toBe(200);
    const unlocked = await visitor.call('POST', `/api/v1/share/${shareToken}/unlock`, {
      password: SHARE_PASSWORD,
    });
    expect(unlocked.status).toBe(204);
    const unlockCookie = unlocked.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    expect(unlockCookie).toMatch(/^pinwall_share=/);
    const opened = await apiClient(TARGET_ORIGIN, { cookie: unlockCookie }).call(
      'GET',
      `/s/${shareToken}`,
      undefined,
      { accept: 'text/html' },
    );
    expect(opened.status).toBe(302);
    const shared = new URL(opened.headers.get('location') ?? '', TARGET_ORIGIN);
    expect((await fetchBytes(shared)).equals(Buffer.from(pages.v2))).toBe(true);
  });

  // 6. A second restore into the same target is refused.
  await test.step('refuse a second restore into the now non-empty target', async () => {
    const again = await target?.exec(['pinwall', 'restore', '--in', '-'], { stdin: archive });
    expect(again?.code).toBe(1);
    expect(again?.stderr).toContain('Restore failed: The target is not empty');
  });
});
