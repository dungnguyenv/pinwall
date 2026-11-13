import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  type Container,
  removeContainers,
  run,
  runImage,
  waitForSetupUrl,
  waitUntilReady,
} from '../support/docker.ts';
import { type Api, apiClient, publishSite, setupAndSignIn, signIn } from '../support/node-api.ts';

/*
 * Acceptance 1.1-6 with real images: an installation of the published 1.0.0 image, upgraded in
 * place to the image under test, answers exactly as before in team mode; its 1.0.0 backup
 * restores into an empty 1.1 installation with the same answers; and the upgraded installation,
 * switched to personal mode, gives each project to its owner. The walks share what the first one
 * makes, so they run in order.
 */

const image = process.env.PINWALL_ACCEPTANCE_IMAGE || 'pinwall:acceptance';
/** The v1.0.0 index on GHCR (amd64 and arm64), by digest, so a moved tag changes nothing here. */
const V1_0_0 =
  'ghcr.io/dungnguyenv/pinwall@sha256:6cc968c9702bbf676fbd049cca63980c8dfc21b7df90f9c74d4e88cd2592e68b';
const upgradeFrom = process.env.PINWALL_ACCEPTANCE_UPGRADE_FROM || V1_0_0;

const id = randomBytes(4).toString('hex');
/** The installation upgraded in place: the 1.0.0 image, then the image under test. */
const UP = { volume: `pinwall-acc-up-${id}`, port: 18122 };
/** The empty 1.1 installation the 1.0.0 backup is restored into. */
const RS = { volume: `pinwall-acc-rs-${id}`, port: 18123 };

const PASSWORD = 'correct horse battery staple';
const SHARE_PASSWORD = 'Mật khẩu chia sẻ';

/** Every container this file started, removed by name at the end with both volumes. */
const started: string[] = [];

async function start(
  name: string,
  from: string,
  at: { volume: string; port: number },
  env?: Record<string, string>,
): Promise<Container> {
  started.push(name);
  return runImage({ image: from, name, ...at, env });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // `runImage` never pulls. The start image is public, so it is pulled anonymously, with an empty
  // Docker configuration: no stored login or credential helper is asked for anything.
  if ((await run('docker', ['image', 'inspect', upgradeFrom])).code === 0) return;
  test.setTimeout(600_000);
  const config = await mkdtemp(join(tmpdir(), 'pinwall-acc-docker-'));
  try {
    await writeFile(join(config, 'config.json'), '{}');
    const pulled = await run('docker', ['pull', upgradeFrom], {
      env: { ...process.env, DOCKER_CONFIG: config },
    });
    if (pulled.code !== 0) throw new Error(`docker pull ${upgradeFrom}: ${pulled.stderr.trim()}`);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test.afterAll(async () => {
  await removeContainers(started, [UP.volume, RS.volume]);
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

/** The archive's first entry, which must be `manifest.json`, parsed. */
function manifestOf(archive: Buffer): { pinwall_version: string; migrations: string[] } {
  expect(archive.subarray(257, 262).toString('latin1')).toBe('ustar');
  expect(archive.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')).toBe('manifest.json');
  const size = Number.parseInt(archive.subarray(124, 136).toString('latin1').trim(), 8);
  return JSON.parse(archive.subarray(512, 512 + size).toString('utf8'));
}

/** `GET path`, which must answer 200; its JSON body. */
async function read<T>(api: Api, path: string): Promise<T> {
  const answer = await api.call<T>('GET', path);
  expect(answer.status, path).toBe(200);
  return answer.json;
}

/** The grant a raw link redirects to. */
async function grantOf(api: Api, link: string): Promise<URL> {
  const raw = await api.call('GET', link, undefined, { accept: '*/*' });
  expect(raw.status, link).toBe(302);
  return new URL(raw.headers.get('location') ?? '', api.origin);
}

async function fetchBytes(url: URL): Promise<Buffer> {
  const response = await fetch(url);
  expect(response.status, url.pathname).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

/** What the owner sees of an installation, through the API and the raw links. */
interface Snapshot {
  config: unknown;
  me: unknown;
  projects: unknown;
  artifacts: unknown;
  /** The version list of each artifact, by artifact id. */
  versions: Record<string, unknown>;
  /** The comment threads of each artifact, by artifact id. */
  threads: Record<string, unknown>;
  /** The SHA-256 of each file served through a raw link, by `<artifact id> v<n> <path>`. */
  files: Record<string, string>;
  /** The ids "chup anh" finds, in their order. */
  search: string[];
}

/**
 * Reads everything in one fixed order, so two snapshots of the same data are equal whatever a
 * read leaves behind. The installation's own origin, which the API puts into links, is written
 * as `<origin>`: two installations on two ports hold the same data.
 */
async function snapshot(api: Api): Promise<Snapshot> {
  // The public configuration carries no server version, so it is compared whole.
  const config = await read(api, '/api/v1/config/public');
  const me = await read(api, '/api/v1/me');
  const projects = await read(api, '/api/v1/projects');
  const artifacts = await read<{ items: { id: string }[] }>(api, '/api/v1/artifacts');
  const versions: Snapshot['versions'] = {};
  const threads: Snapshot['threads'] = {};
  const files: Snapshot['files'] = {};
  for (const { id: artifactId } of artifacts.items) {
    const list = await read<{ items: { number: number }[] }>(
      api,
      `/api/v1/artifacts/${artifactId}/versions`,
    );
    versions[artifactId] = list;
    threads[artifactId] = await read(api, `/api/v1/artifacts/${artifactId}/comments`);
    for (const { number } of list.items) {
      const listed = await read<{ items: { path: string }[] }>(
        api,
        `/api/v1/artifacts/${artifactId}/versions/${number}/files`,
      );
      const grant = await grantOf(api, `/a/${artifactId}/v/${number}/raw`);
      for (const { path } of listed.items) {
        files[`${artifactId} v${number} ${path}`] = sha256(await fetchBytes(new URL(path, grant)));
      }
    }
  }
  const found = await read<{ items: { id: string }[] }>(api, '/api/v1/artifacts?q=chup%20anh');
  const taken: Snapshot = {
    config,
    me,
    projects,
    artifacts,
    versions,
    threads,
    files,
    search: found.items.map((item) => item.id),
  };
  return JSON.parse(JSON.stringify(taken).replaceAll(api.origin, '<origin>'));
}

/** Made by the first walk on the 1.0.0 installation, and compared against by every walk. */
let s0: Snapshot;
let backup: Buffer;
let shareToken: string;

const photo = randomPng(48);
const pages = {
  v1: '<!doctype html><meta charset="utf-8"><title>Lịch chụp ảnh cưới</title><h1>Dịch vụ chụp ảnh</h1><img src="img/photo.png">',
  v2: '<!doctype html><meta charset="utf-8"><title>Lịch chụp ảnh cưới</title><h1>Dịch vụ chụp ảnh cưới</h1><img src="img/photo.png"><p>Giá trọn gói: 12.000.000 đồng</p>',
  prices: '<!doctype html><meta charset="utf-8"><title>Bảng giá</title><p>Bảng giá năm nay</p>',
};

test('1.1-6: a 1.0.0 installation upgraded in place answers exactly as before in team mode', async () => {
  test.setTimeout(420_000);

  await test.step(`set up ${upgradeFrom} with projects, versions, comments and a share link`, async () => {
    const a = await start(`pinwall-acc-up-${id}-a`, upgradeFrom, UP);
    const api = await setupAndSignIn(a.origin, await waitForSetupUrl(a, 120_000), PASSWORD);
    const project = await api.call<{ id: string }>('POST', '/api/v1/projects', { name: 'Ảnh' });
    expect(project.status).toBe(201);
    const v1 = await publishSite(
      api,
      { 'index.html': pages.v1, 'img/photo.png': photo },
      { project_id: project.json.id, name: 'Lịch chụp ảnh cưới', tags: ['ảnh cưới'] },
    );
    const v2 = await publishSite(
      api,
      { 'index.html': pages.v2, 'img/photo.png': photo },
      { artifact_id: v1.artifact_id, expected_version_id: v1.version_id },
    );
    expect(v2.version_number).toBe(2);
    // A second artifact, in the default project.
    await publishSite(api, { 'index.html': pages.prices });
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
    const reply = await api.call('POST', `/api/v1/comments/${thread.json.id}/replies`, {
      body: 'Đã thêm ở bản 2',
    });
    expect(reply.status).toBe(201);
    const share = await api.call<{ token: string }>(
      'POST',
      `/api/v1/artifacts/${v1.artifact_id}/share-links`,
      { password: SHARE_PASSWORD },
    );
    expect(share.status).toBe(201);
    shareToken = share.json.token;

    s0 = await snapshot(api);
    // The snapshot holds what was made, so comparing it proves something.
    expect(Object.keys(s0.versions)).toHaveLength(2);
    expect(Object.keys(s0.files)).toHaveLength(5);
    expect(s0.search).toContain(v1.artifact_id);
    expect(JSON.stringify(s0.threads)).toContain('Đã thêm ở bản 2');

    const archive = await a.exec(['pinwall', 'backup', '--out', '-']);
    expect(archive.code, archive.stderr).toBe(0);
    backup = archive.stdout;
    // A database of the release it upgrades from, without the spaces migration.
    const manifest = manifestOf(backup);
    expect(manifest.pinwall_version).toMatch(/^1\.0\./);
    expect(manifest.migrations).not.toContain('0003_spaces');
    await a.stop();
  });

  await test.step('start the image under test on the same volume', async () => {
    const b = await start(`pinwall-acc-up-${id}-b`, image, UP);
    await waitUntilReady(b, 120_000);
    // Serving migrated the database before it listened: nothing is left for `migrate` to apply.
    const migrate = await b.exec(['pinwall', 'migrate']);
    expect(migrate.code, migrate.stderr).toBe(0);
    const line = `${migrate.stdout.toString('utf8')}\n${migrate.stderr}`
      .split('\n')
      .find((text) => text.includes('"migrated"'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ msg: 'migrated', applied: [] });

    const api = await signIn(b.origin, PASSWORD);
    expect(await snapshot(api)).toEqual(s0);

    // The share link is locked until its password is given, then serves the newest version.
    const visitor = apiClient(b.origin, {});
    const locked = await visitor.call<{ error: { details?: { password_required?: boolean } } }>(
      'GET',
      `/api/v1/share/${shareToken}`,
    );
    expect(locked.status).toBe(401);
    expect(locked.json.error.details?.password_required).toBe(true);
    const unlocked = await visitor.call('POST', `/api/v1/share/${shareToken}/unlock`, {
      password: SHARE_PASSWORD,
    });
    expect(unlocked.status).toBe(204);
    const unlockCookie = unlocked.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    expect(unlockCookie).toMatch(/^pinwall_share=/);
    const opened = await apiClient(b.origin, { cookie: unlockCookie }).call(
      'GET',
      `/s/${shareToken}`,
      undefined,
      { accept: 'text/html' },
    );
    expect(opened.status).toBe(302);
    const page = await fetchBytes(new URL(opened.headers.get('location') ?? '', b.origin));
    expect(page.equals(Buffer.from(pages.v2))).toBe(true);
    await b.stop();
  });
});

test('1.1-6: a 1.0.0 backup restores into 1.1 as if 1.1 had migrated it', async () => {
  const c = await start(`pinwall-acc-rs-${id}`, image, RS);
  await waitUntilReady(c, 120_000);
  const restored = await c.exec(['pinwall', 'restore', '--in', '-'], { stdin: backup });
  expect(restored.code, restored.stderr).toBe(0);
  expect(restored.stderr).toContain('restore complete');
  const api = await signIn(c.origin, PASSWORD);
  expect(await snapshot(api)).toEqual(s0);
  await c.stop();
});

test('1.1-6: switching the upgraded installation to personal gives each project to its owner', async () => {
  const p = await start(`pinwall-acc-up-${id}-p`, image, UP, { PINWALL_VISIBILITY: 'personal' });
  await waitUntilReady(p, 120_000);
  const api = await signIn(p.origin, PASSWORD);
  const config = await read<{ visibility?: string }>(api, '/api/v1/config/public');
  expect(config.visibility).toBe('personal');
  const me = await read<{ id: string }>(api, '/api/v1/me');
  const projects = await read<{ items: { owner?: { id: string } | null; role?: string }[] }>(
    api,
    '/api/v1/projects',
  );
  expect(projects.items).toHaveLength((s0.projects as { items: unknown[] }).items.length);
  for (const project of projects.items) {
    expect(project.owner?.id).toBe(me.id);
    expect(project.role).toBe('owner');
  }
  const ids = (list: { items: { id: string }[] }) => list.items.map((item) => item.id).sort();
  const artifacts = await read<{ items: { id: string }[] }>(api, '/api/v1/artifacts');
  expect(ids(artifacts)).toEqual(ids(s0.artifacts as { items: { id: string }[] }));
  await p.stop();
});
