import { ArtifactList } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { Visibility } from '../../src/config/types.ts';
import { searchQuery, searchUpsert } from '../../src/db/dialect.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { listArtifacts } from '../../src/domain/artifacts.ts';
import { createProject } from '../../src/domain/projects.ts';
import { type Scope, SYSTEM_SCOPE, scopeForUser } from '../../src/domain/spaces.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { newId } from '../../src/lib/ids.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { restClient } from '../helpers/rest.ts';
import { MODES, spacesContext, spacesFixture, withVisibility } from './fixture.ts';

/** More matches than a search reaches (1,000), all better ranked than a match in a long page. */
const CROWD = 1200;
/** Artifact rows per insert. */
const BATCH = 200;

describe.each(dialects)('search in spaces on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx?.close());

  const clock = () => ctx.deps.clock as FixedClock;
  const signIn = (name: string) => createSignedInUser(ctx, { kind: 'oidc', name });

  /** A new artifact of `actor` named `name` whose page is `body`, in `projectId` or their default. */
  async function publish(
    actor: UserRow,
    name: string,
    body: string,
    projectId: string | null = null,
  ): Promise<string> {
    const { artifact } = await publishFiles(
      ctx,
      actor,
      { 'index.html': `<!doctype html><p>${body}</p>` },
      { kind: 'new_artifact', projectId, name, tags: [] },
    );
    return artifact.id;
  }

  /**
   * `count` artifacts of `ownerId` in `projectId`, each named and indexed 'report n': rows in
   * batches and the index in one transaction, without a publish each.
   */
  async function seedReports(projectId: string, ownerId: string, count: number): Promise<void> {
    const { db, dialect } = ctx.deps.db;
    const now = ctx.deps.clock.now();
    const rows = Array.from({ length: count }, (_, n) => ({
      id: newId('art'),
      project_id: projectId,
      name: `report ${n}`,
      kind: 'html' as const,
      current_version_id: null,
      latest_number: 0,
      created_by: ownerId,
      created_at: now,
      updated_at: now,
    }));
    await db.transaction().execute(async (trx) => {
      for (let start = 0; start < rows.length; start += BATCH) {
        await trx
          .insertInto('artifacts')
          .values(rows.slice(start, start + BATCH))
          .execute();
      }
      for (const row of rows) {
        await searchUpsert(
          { db: trx, dialect },
          { artifactId: row.id, name: row.name, tags: '', body: '' },
        );
      }
    });
  }

  /** One page of `GET /artifacts?q=` as the holder of `cookie`: ids and next cursor. */
  async function searchOver(cookie: string, q: string) {
    const r = await restClient(ctx, cookie).get(`/artifacts?q=${encodeURIComponent(q)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const page = ArtifactList.parse(r.body);
    return { ids: page.items.map((a) => a.id), next: page.next_cursor };
  }

  test("another space's matches neither crowd out nor reorder a person's results", async () => {
    ctx = await spacesContext(dialect, 'personal');
    const A = await signIn('A');
    const S = await signIn('S');
    const short = await publish(S.user, 'Short', 'report report report');
    const long = await publish(S.user, 'Long', `${'filler '.repeat(2000)}report`);

    // The order an instance without A's matches gives.
    const alone = await searchOver(S.cookie, 'report');
    expect(alone).toEqual({ ids: [short, long], next: null });

    const reports = await createProject(ctx.deps, A.user, { name: 'Reports' });
    await seedReports(reports.id, A.user.id, CROWD);
    expect(await searchOver(S.cookie, 'report')).toEqual(alone);
    expect(await searchQuery(ctx.deps.db, 'report', 1, scopeForUser(ctx.deps, S.user))).toEqual([
      short,
    ]);
  });

  test.each(MODES)('search finds nothing of another space (%s)', async (mode) => {
    ctx = await spacesContext(dialect, mode);
    const fx = await spacesFixture(ctx);
    const { A, S } = fx.people;
    // A third version of q gives its page a word no other page has.
    await publishFiles(
      ctx,
      A.user,
      { 'index.html': '<!doctype html><p>Zanzibar</p>' },
      { kind: 'new_version', artifactId: fx.ids.q, expectedVersionId: fx.ids.qV2 },
    );
    expect((await searchOver(A.cookie, 'zanzibar')).ids).toEqual([fx.ids.q]);
    expect((await searchOver(S.cookie, 'zanzibar')).ids).toEqual(mode === 'team' ? [fx.ids.q] : []);
  });

  test('team mode runs the 1.0 search', async () => {
    ctx = await spacesContext(dialect, 'team');
    const A = await signIn('A');
    const S = await signIn('S');
    const reports = await createProject(ctx.deps, A.user, { name: 'Reports' });
    await seedReports(reports.id, A.user.id, CROWD);
    const team = scopeForUser(ctx.deps, S.user);

    const all = await searchQuery(ctx.deps.db, 'report', 2 * CROWD, SYSTEM_SCOPE);
    expect(all).toHaveLength(CROWD);
    expect(await searchQuery(ctx.deps.db, 'report', 2 * CROWD, team)).toEqual(all);

    // Only the best 1,000 can be reached, in team mode as in 1.0.
    const list = (scope: Scope) =>
      listArtifacts(ctx.deps, scope, { q: 'report', limit: CROWD, cursor: null });
    const reached = await list(team);
    expect(reached.items.map((a) => a.id)).toEqual(all.slice(0, 1000));
    expect(reached.nextCursor).toBeNull();
    expect(await list(SYSTEM_SCOPE)).toEqual(reached);
  });

  /**
   * In a `personal` instance: S's three artifacts, then, a minute later, A's two in A's project.
   * Every page reads 'Quarterly figures'.
   */
  async function twoSpaces() {
    const body = 'Quarterly figures';
    ctx = await spacesContext(dialect, 'personal');
    const A = await signIn('A');
    const S = await signIn('S');
    const own: string[] = [];
    for (const name of ['S1', 'S2', 'S3']) own.push(await publish(S.user, name, body));
    clock().advance(60_000);
    const project = await createProject(ctx.deps, A.user, { name: 'A' });
    const others: string[] = [];
    for (const name of ['A1', 'A2']) others.push(await publish(A.user, name, body, project.id));
    /** S's scope in `mode`, with the deps of that mode. */
    const as = (mode: Visibility) => {
      const deps = withVisibility(ctx.deps, mode);
      return { deps, scope: scopeForUser(deps, S.user) };
    };
    return { own, others, as };
  }

  test('a list cursor minted in team mode returns only visible items in personal mode', async () => {
    const { own, others, as } = await twoSpaces();
    const team = as('team');
    const first = await listArtifacts(team.deps, team.scope, { limit: 1, cursor: null });
    expect(others).toContain(first.items[0]?.id);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();

    // In team mode the cursor still leads to A's other artifact.
    const teamRest = await listArtifacts(team.deps, team.scope, { limit: 100, cursor });
    expect(teamRest.items.some((a) => others.includes(a.id))).toBe(true);

    const personal = as('personal');
    const rest = await listArtifacts(personal.deps, personal.scope, { limit: 100, cursor });
    const ids = rest.items.map((a) => a.id);
    expect(own).toEqual(expect.arrayContaining(ids));
    expect([...ids].sort()).toEqual([...own].sort());
    expect(rest.nextCursor).toBeNull();
  });

  test('a search cursor minted in team mode returns only visible items in personal mode', async () => {
    const { own, others, as } = await twoSpaces();
    const team = as('team');
    const first = await listArtifacts(team.deps, team.scope, {
      q: 'quarterly',
      limit: 1,
      cursor: null,
    });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const teamRest = await listArtifacts(team.deps, team.scope, {
      q: 'quarterly',
      limit: 100,
      cursor,
    });
    expect(teamRest.items.some((a) => others.includes(a.id))).toBe(true);

    const personal = as('personal');
    const rest = await listArtifacts(personal.deps, personal.scope, {
      q: 'quarterly',
      limit: 100,
      cursor,
    });
    const ids = rest.items.map((a) => a.id);
    expect(own).toEqual(expect.arrayContaining(ids));
    expect(ids).toHaveLength(own.length - 1);
    expect(rest.nextCursor).toBeNull();
  });
});
