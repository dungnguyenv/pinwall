import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PublishSession } from '@pinwall/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { createProject } from '../../src/domain/projects.ts';
import { limitsOf, usageOf } from '../../src/domain/usage.ts';
import type { PublishTarget } from '../../src/domain/versions.ts';
import { formatBytes } from '../../src/lib/format.ts';
import { t } from '../../src/lib/i18n.ts';
import { referencedShas } from '../helpers/backup.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import type { Reply } from '../helpers/rest.ts';
import {
  addMember,
  MODES,
  type Person,
  type SpacesFixture,
  spacesClient,
  spacesFixture,
} from '../spaces/fixture.ts';
import { contextWith, moderationContext, setQuota } from './helpers.ts';

test('the loader reads the quota settings', () => {
  expect(loadConfig({}).quota).toEqual({ bytes: 0, artifacts: 0 });
  expect(
    loadConfig({ PINWALL_QUOTA_BYTES: '500MB', PINWALL_QUOTA_ARTIFACTS: '200' }).quota,
  ).toEqual({ bytes: 500_000_000, artifacts: 200 });
  expect(() => loadConfig({ PINWALL_QUOTA_ARTIFACTS: '-1' })).toThrow(
    /PINWALL_QUOTA_ARTIFACTS: must be a whole number/,
  );
});

/** A page of its own, so its blob is new: `label` in it, padded with spaces to `size` bytes. */
function page(label: string, size?: number): string {
  const html = `<!doctype html><p>${label} ${Math.random()}</p>`;
  return size === undefined ? html : html.padEnd(size, ' ');
}

/** A web upload's form: the target, then `html` as `index.html`. */
function uploadForm(target: object, html: string): FormData {
  const form = new FormData();
  form.append('target', JSON.stringify(target));
  form.append('file', new File([html], 'index.html'));
  return form;
}

/** What a refusal over the bytes quota answers, as REST sends it. */
function bytesRefusal(o: {
  used: number;
  limit: number;
  needed: number;
  owner: Person;
  other: boolean;
}) {
  const sizes = {
    needed: formatBytes(o.needed),
    used: formatBytes(o.used),
    limit: formatBytes(o.limit),
  };
  return {
    error: {
      code: 'quota_exceeded',
      message: o.other
        ? t('quota.bytes.other', { ...sizes, owner: o.owner.user.name ?? '' })
        : t('quota.bytes.own', sizes),
      details: {
        used_bytes: o.used,
        limit_bytes: o.limit,
        needed_bytes: o.needed,
        space_owner: { id: o.owner.user.id, name: o.owner.user.name },
      },
    },
  };
}

/** The ways to publish a new version of p as its owner, each refused over the bytes quota. */
const PATHS = ['upload URL', 'inline', 'web upload', 'restore', 'MCP publish_inline'] as const;

describe.each(dialects)('quotas on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await moderationContext(dialect, mode);
    });
    // Tests set quotas and publish, so each gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    const db = () => ctx.deps.db.db;
    const usage = (person: Person) => usageOf(db(), ctx.deps.config, person.user.id);

    /** The sum of the sizes of every version of `artifactIds`. */
    async function bytesOf(artifactIds: string[]): Promise<number> {
      const rows = await db()
        .selectFrom('versions')
        .select('total_bytes')
        .where('artifact_id', 'in', artifactIds)
        .execute();
      return rows.reduce((sum, row) => sum + row.total_bytes, 0);
    }

    /** Version `n` of p's size. */
    async function sizeOfp(n: number): Promise<number> {
      const row = await db()
        .selectFrom('versions')
        .select('total_bytes')
        .where('artifact_id', '=', fx.ids.p)
        .where('number', '=', n)
        .executeTakeFirstOrThrow();
      return row.total_bytes;
    }

    /** p's versions and every artifact's id: what a refused publish must leave as it was. */
    async function written(): Promise<{ versionsOfp: unknown[]; artifacts: string[] }> {
      const versionsOfp = await db()
        .selectFrom('versions')
        .selectAll()
        .where('artifact_id', '=', fx.ids.p)
        .orderBy('number')
        .execute();
      const artifacts = await db().selectFrom('artifacts').select('id').orderBy('id').execute();
      return { versionsOfp, artifacts: artifacts.map((row) => row.id) };
    }

    /** The keys in the blob store, sorted as `referencedShas` sorts them. */
    async function storedBlobs(): Promise<string[]> {
      const keys: string[] = [];
      for await (const key of ctx.deps.blobs.list()) keys.push(key);
      return keys.sort();
    }

    /**
     * Runs `work` (two commits into `projectIds`) while another transaction holds the projects'
     * rows, and lets go once two statements wait on a lock: the commits then go on side by side.
     * Postgres only.
     */
    async function releasedTogether<T>(projectIds: string[], work: () => Promise<T>): Promise<T> {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signalHeld = () => {};
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const holder = db()
        .transaction()
        .execute(async (trx) => {
          await trx
            .selectFrom('projects')
            .select('id')
            .where('id', 'in', projectIds)
            .forUpdate()
            .execute();
          signalHeld();
          await released;
        });
      await held;
      const running = work();
      try {
        await untilWaitingOnLocks(2, running);
      } finally {
        release(); // also when the wait failed, so the holder does not hang
      }
      await holder;
      return running;
    }

    /** Resolves once `n` statements of this database wait on a lock; fails after 5 s or when `settled` has. */
    async function untilWaitingOnLocks(n: number, settled: Promise<unknown>): Promise<void> {
      let done = false;
      void settled.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      const deadline = Date.now() + 5000;
      while (!done && Date.now() < deadline) {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `.execute(db());
        if ((rows[0]?.n ?? 0) >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${n} statements never waited on a lock together`);
    }

    /** No version, no artifact and no orphan blob was added since `before`. */
    async function expectNothingLeft(before: Awaited<ReturnType<typeof written>>): Promise<void> {
      expect(await written()).toEqual(before);
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
    }

    /** An upload URL `person` asks for over REST. */
    async function uploadUrl(person: Person, target: object): Promise<string> {
      const r = await spacesClient(ctx, person.cookie).post('/publish-sessions', { target });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return PublishSession.parse(r.body).upload_url;
    }

    /** Sends `html` to an upload URL, as the documented single-file command does. */
    async function upload(url: string, html: string): Promise<Reply> {
      const res = await ctx.request(url, {
        method: 'POST',
        body: html,
        headers: { 'content-type': 'text/html' },
      });
      return { status: res.status, headers: res.headers, body: await res.json() };
    }

    /** `person`'s inline publish of `html` to `target`, over REST on `c`. */
    function inline(c: TestContext, person: Person, target: object, html: string) {
      return spacesClient(c, person.cookie).post('/publish/inline', {
        target,
        files: [{ path: 'index.html', content: html }],
      });
    }

    test('usage counts by project owner in personal mode and by publisher in team mode', async () => {
      const { A, E } = fx.people;
      const { p, q, e } = fx.ids;
      if (mode === 'personal') {
        expect(await usage(A)).toEqual({ bytes: await bytesOf([p, q, e]), artifacts: 3 });
        expect(await usage(E)).toEqual({ bytes: 0, artifacts: 0 });
      } else {
        expect(await usage(A)).toEqual({ bytes: await bytesOf([p, q]), artifacts: 2 });
        expect(await usage(E)).toEqual({ bytes: await bytesOf([e]), artifacts: 1 });
      }
    });

    test('limitsOf: admins have none, an override replaces the default, 0 means none', async () => {
      const { E, X } = fx.people;
      const config = loadConfig({
        PINWALL_QUOTA_BYTES: '500MB',
        PINWALL_QUOTA_ARTIFACTS: '200',
      });
      const rowOf = (person: Person) =>
        db()
          .selectFrom('users')
          .selectAll()
          .where('id', '=', person.user.id)
          .executeTakeFirstOrThrow();

      expect(limitsOf(config, await rowOf(E))).toEqual({ bytes: 500_000_000, artifacts: 200 });
      expect(limitsOf(config, await rowOf(X))).toEqual({ bytes: null, artifacts: null });
      await setQuota(ctx, X.user.id, { bytes: 10, artifacts: 1 });
      expect(limitsOf(config, await rowOf(X))).toEqual({ bytes: null, artifacts: null });

      await setQuota(ctx, E.user.id, { bytes: 0 });
      expect(limitsOf(config, await rowOf(E))).toEqual({ bytes: null, artifacts: 200 });
      await setQuota(ctx, E.user.id, { bytes: null, artifacts: 5 });
      expect(limitsOf(config, await rowOf(E))).toEqual({ bytes: 500_000_000, artifacts: 5 });
      // Without an instance limit, an override still sets one.
      expect(limitsOf(ctx.deps.config, await rowOf(E))).toEqual({ bytes: null, artifacts: 5 });
    });

    test.each(PATHS)(
      '%s over the bytes quota is refused with quota_exceeded and leaves nothing',
      async (path) => {
        const { A } = fx.people;
        const { p, pV2 } = fx.ids;
        const used = (await usage(A)).bytes;
        const limit = used + 10;
        await setQuota(ctx, A.user.id, { bytes: limit });
        const onp = { artifact_id: p, expected_version_id: pV2 };
        const html = page(`A ${path} by A`);
        const before = await written();
        const api = spacesClient(ctx, A.cookie);

        let needed = Buffer.byteLength(html);
        let reply: Reply | null = null;
        if (path === 'upload URL') {
          reply = await upload(await uploadUrl(A, onp), html);
        } else if (path === 'inline') {
          reply = await inline(ctx, A, onp, html);
        } else if (path === 'web upload') {
          reply = await api.form('/publish/upload', uploadForm(onp, html));
        } else if (path === 'restore') {
          needed = await sizeOfp(1);
          reply = await api.post(`/artifacts/${p}/versions/1/restore`, {
            expected_version_id: pV2,
          });
        } else {
          const agent = await connectMcp(ctx, { bearer: A.token });
          try {
            const r = (await agent.callTool({
              name: 'publish_inline',
              arguments: { ...onp, files: [{ path: 'index.html', content: html }] },
            })) as CallToolResult;
            const expected = bytesRefusal({ used, limit, needed, owner: A, other: false });
            expect(r.isError).toBe(true);
            expect(toolText(r)).toContain(expected.error.message);
            expect(toolText(r)).toContain(t('mcp.hint.quota_exceeded'));
            expect(toolText(r)).toContain(JSON.stringify(expected.error.details));
          } finally {
            await agent.close();
          }
        }
        if (reply !== null) {
          expect(reply.status, JSON.stringify(reply.body)).toBe(413);
          expect(reply.body).toEqual(bytesRefusal({ used, limit, needed, owner: A, other: false }));
        }
        await expectNothingLeft(before);
      },
    );

    test('a full space refuses a publish session and a web upload before any byte is read', async () => {
      const { A } = fx.people;
      const used = (await usage(A)).bytes;
      await setQuota(ctx, A.user.id, { bytes: 1 });
      const api = spacesClient(ctx, A.cookie);
      const intoP = { project_id: fx.ids.P };
      const refusal = bytesRefusal({ used, limit: 1, needed: 0, owner: A, other: false });

      const session = await api.post('/publish-sessions', { target: intoP });
      expect(session.status, JSON.stringify(session.body)).toBe(413);
      expect(session.body).toEqual(refusal);

      const before = await written();
      const web = await api.form('/publish/upload', uploadForm(intoP, page('Web upload')));
      expect(web.status, JSON.stringify(web.body)).toBe(413);
      expect(web.body).toEqual(refusal);
      await expectNothingLeft(before);
    });

    test('the artifacts quota refuses a new artifact but not a new version', async () => {
      const { A } = fx.people;
      const { artifacts } = await usage(A);
      await setQuota(ctx, A.user.id, { artifacts });
      const before = await written();

      const refused = await inline(ctx, A, { project_id: fx.ids.Q }, page('New in Q'));
      expect(refused.status, JSON.stringify(refused.body)).toBe(413);
      expect(refused.body).toEqual({
        error: {
          code: 'quota_exceeded',
          message: t('quota.artifacts.own', { used: artifacts, limit: artifacts }),
          details: {
            used_artifacts: artifacts,
            limit_artifacts: artifacts,
            space_owner: { id: A.user.id, name: 'A' },
          },
        },
      });
      await expectNothingLeft(before);

      // A new version adds no artifact: even a space already over its artifacts limit takes one.
      await setQuota(ctx, A.user.id, { artifacts: artifacts - 1 });
      const onp = { artifact_id: fx.ids.p, expected_version_id: fx.ids.pV2 };
      const version = await inline(ctx, A, onp, page('Version 3 of p'));
      expect(version.status, JSON.stringify(version.body)).toBe(201);
    });

    test("an editor's publish counts against the owner's quota and says whose space is full", async () => {
      const { A, E } = fx.people;
      const used = (await usage(A)).bytes;
      await setQuota(ctx, A.user.id, { bytes: used });
      const html = page('New in P by E');
      const before = await written();

      const intoP = await inline(ctx, E, { project_id: fx.ids.P }, html);
      if (mode === 'personal') {
        expect(intoP.status, JSON.stringify(intoP.body)).toBe(413);
        const refusal = bytesRefusal({
          used,
          limit: used,
          needed: Buffer.byteLength(html),
          owner: A,
          other: true,
        });
        expect(intoP.body).toEqual(refusal);
        expect(refusal.error.message).toBe(
          t('quota.bytes.other', {
            needed: formatBytes(Buffer.byteLength(html)),
            owner: 'A',
            used: formatBytes(used),
            limit: formatBytes(used),
          }),
        );
        await expectNothingLeft(before);
      } else {
        // In team mode the version counts toward E, who has no limit.
        expect(intoP.status, JSON.stringify(intoP.body)).toBe(201);
      }

      const ownDefault = await inline(ctx, E, {}, page('New in E’s default'));
      expect(ownDefault.status, JSON.stringify(ownDefault.body)).toBe(201);
    });

    test('two publishes at the edge of the quota at once: exactly one commits', async () => {
      const { A, E } = fx.people;
      const used = (await usage(A)).bytes;
      await setQuota(ctx, A.user.id, { bytes: used + 1000 });
      const intoP = { project_id: fx.ids.P };
      // In team mode E's publish would count toward E, so both are A's there.
      const second = mode === 'personal' ? E : A;
      const urls = [await uploadUrl(A, intoP), await uploadUrl(second, intoP)];
      const artifactsInP = async () =>
        (
          await db()
            .selectFrom('artifacts')
            .select('id')
            .where('project_id', '=', fx.ids.P)
            .execute()
        ).length;
      const inPBefore = await artifactsInP();

      const both = () =>
        Promise.all(urls.map((url, i) => upload(url, page(`Page ${i} at the edge`, 600))));
      // On SQLite commits take turns anyway. On Postgres both are held at their read of P until
      // each waits there, then let go at once: from there on only the quota lock stands between
      // two commits that would each count the usage before the other's version.
      const replies =
        dialect === 'postgres' ? await releasedTogether([fx.ids.P], both) : await both();
      expect(
        replies.map((r) => r.status).sort(),
        JSON.stringify(replies.map((r) => r.body)),
      ).toEqual([201, 413]);
      expect(await artifactsInP()).toBe(inPBefore + 1);
      expect(await usage(A)).toMatchObject({ bytes: used + 600 });
      expect(await storedBlobs()).toEqual(await referencedShas(ctx.deps));
    });

    test.runIf(dialect === 'postgres')(
      'a quota an admin lowers while a publish waits for the space is the one it is held to',
      async () => {
        const { A } = fx.people;
        const used = (await usage(A)).bytes;
        await setQuota(ctx, A.user.id, { bytes: used + 10_000 });
        const before = await written();
        // The admin's change holds A's row until the publish waits for it at its quota lock.
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let held = () => {};
        const holding = new Promise<void>((resolve) => {
          held = resolve;
        });
        const lowering = db()
          .transaction()
          .execute(async (trx) => {
            await trx
              .updateTable('users')
              .set({ quota_bytes: used })
              .where('id', '=', A.user.id)
              .execute();
            held();
            await released;
          });
        try {
          await holding;
          const target: PublishTarget = {
            kind: 'new_artifact',
            projectId: fx.ids.P,
            name: null,
            tags: [],
          };
          const publishing = publishFiles(
            ctx,
            A.user,
            { 'index.html': page('While lowered') },
            target,
          );
          await untilWaitingOnLocks(1, publishing);
          release();
          await lowering;
          const error = await publishing.then(
            () => null,
            (err: unknown) => err,
          );
          expect(error).toMatchObject({ code: 'quota_exceeded', details: { limit_bytes: used } });
        } finally {
          release();
          await lowering;
        }
        await expectNothingLeft(before);
      },
    );

    test('a refusal names the space owner by name, else email, else id', async () => {
      const { A, E } = fx.people;
      const used = (await usage(A)).bytes;
      await setQuota(ctx, A.user.id, { bytes: used });
      const nameOf = async () => {
        const r = await inline(ctx, E, { project_id: fx.ids.P }, page('Into a full P'));
        return (r.body as { error: { details: { space_owner: unknown } } }).error.details
          .space_owner;
      };
      if (mode === 'team') {
        // E's version counts toward E, who has no limit: nothing to name.
        expect((await inline(ctx, E, { project_id: fx.ids.P }, page('In team'))).status).toBe(201);
        return;
      }
      const rename = (set: { name: string | null; email?: string | null }) =>
        db().updateTable('users').set(set).where('id', '=', A.user.id).execute();
      await rename({ name: null });
      expect(await nameOf()).toEqual({ id: A.user.id, name: A.user.email });
      await rename({ name: null, email: null });
      expect(await nameOf()).toEqual({ id: A.user.id, name: A.user.id });
    });

    test("two editors publishing into each other's spaces at once both commit", async () => {
      // Each commit holds its space owner's row, then writes rows that name its publisher, the
      // other one: the lock must not stop such writes, or each would wait for the other.
      const { A, E } = fx.people;
      const R = await createProject(ctx.deps, E.user, { name: 'R' });
      await addMember(ctx, R.id, A.user.id, 'editor', E.user.id);
      await setQuota(ctx, A.user.id, { bytes: 10_000_000 });
      await setQuota(ctx, E.user.id, { bytes: 10_000_000 });
      const urls = [
        await uploadUrl(E, { project_id: fx.ids.P }),
        await uploadUrl(A, { project_id: R.id }),
      ];

      const both = () => Promise.all(urls.map((url, i) => upload(url, page(`Crossed ${i}`))));
      const replies =
        dialect === 'postgres' ? await releasedTogether([fx.ids.P, R.id], both) : await both();
      expect(
        replies.map((r) => r.status),
        JSON.stringify(replies.map((r) => r.body)),
      ).toEqual([201, 201]);
    });

    test('admins are exempt, and a per-person override applies', async () => {
      const { E, X } = fx.people;
      const limited = contextWith(ctx, { quota: { bytes: 1, artifacts: 0 } });

      const byX = await inline(limited, X, {}, page('By X'));
      expect(byX.status, JSON.stringify(byX.body)).toBe(201);
      const byE = await inline(limited, E, {}, page('By E'));
      expect(byE.status, JSON.stringify(byE.body)).toBe(413);
      expect(byE.body).toMatchObject({
        error: { code: 'quota_exceeded', details: { limit_bytes: 1 } },
      });

      await setQuota(ctx, E.user.id, { bytes: 0 });
      const again = await inline(limited, E, {}, page('By E again'));
      expect(again.status, JSON.stringify(again.body)).toBe(201);
    });

    test('a restore counts the restored version in full', async () => {
      const { A } = fx.people;
      const used = (await usage(A)).bytes;
      const v1 = await sizeOfp(1);
      const restore = () =>
        spacesClient(ctx, A.cookie).post(`/artifacts/${fx.ids.p}/versions/1/restore`, {
          expected_version_id: fx.ids.pV2,
        });

      await setQuota(ctx, A.user.id, { bytes: used + v1 - 1 });
      const before = await written();
      const refused = await restore();
      expect(refused.status, JSON.stringify(refused.body)).toBe(413);
      expect(refused.body).toEqual(
        bytesRefusal({ used, limit: used + v1 - 1, needed: v1, owner: A, other: false }),
      );
      await expectNothingLeft(before);

      // Exactly at the limit is allowed.
      await setQuota(ctx, A.user.id, { bytes: used + v1 });
      const restored = await restore();
      expect(restored.status, JSON.stringify(restored.body)).toBe(201);
      expect(await usage(A)).toMatchObject({ bytes: used + v1 });
    });
  });
});
