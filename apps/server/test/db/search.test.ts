import { describe, expect, onTestFinished, test } from 'vitest';
import type { DbHandle } from '../../src/db/connect.ts';
import { searchDelete, searchQuery, searchUpsert } from '../../src/db/dialect.ts';
import { migrateToLatest } from '../../src/db/migrate.ts';
import { dialects, withDb } from '../helpers/db.ts';

const T = 1_762_000_000_000;

describe.each(dialects)('%s search', (dialect) => {
  /** A migrated database holding a project and the artifacts `ids` (Postgres search rows need them). */
  async function open(...ids: string[]): Promise<DbHandle> {
    const h = await withDb(dialect);
    onTestFinished(() => h.close());
    await migrateToLatest(h);
    await h.db
      .insertInto('projects')
      .values({
        id: 'prj_1',
        name: 'Default',
        instructions: '',
        is_default: 1,
        created_at: T,
        updated_at: T,
      })
      .execute();
    for (const id of ids) {
      await h.db
        .insertInto('artifacts')
        .values({
          id,
          project_id: 'prj_1',
          name: id,
          kind: 'html',
          latest_number: 0,
          created_at: T,
          updated_at: T,
        })
        .execute();
    }
    return h;
  }

  test('search is accent-insensitive', async () => {
    const h = await open('art_1');
    await searchUpsert(h, {
      artifactId: 'art_1',
      name: 'Bảng giá',
      tags: '',
      body: 'Dịch vụ chụp ảnh điện thoại',
    });
    expect(await searchQuery(h, 'chup anh', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'dien thoai', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'Chụp', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'bang gi', 10)).toEqual(['art_1']); // prefix
    expect(await searchQuery(h, 'ĐIỆN THOẠI'.normalize('NFD'), 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'chup xe', 10)).toEqual([]); // every word must match
    await searchDelete(h, 'art_1');
    expect(await searchQuery(h, 'chup', 10)).toEqual([]);
  });

  test('search ignores FTS syntax in user input', async () => {
    const h = await open('art_1');
    await searchUpsert(h, { artifactId: 'art_1', name: 'Report', tags: '', body: 'plain text' });
    expect(await searchQuery(h, '"unbalanced AND (', 10)).toEqual([]); // must not throw
    for (const q of [
      'NEAR(plain other, 2)',
      'body:plain OR x',
      '*',
      '^',
      "'",
      '\\',
      '!&|<->:*',
      '',
      '   ',
      'ʼ', // unaccent turns this letter into an apostrophe
      'ː', // ... and this one into a colon
      '½',
    ]) {
      expect(await searchQuery(h, q, 10), q).toEqual([]);
    }
    // Punctuation around real words is dropped, not parsed.
    expect(await searchQuery(h, '(plain) -text*', 10)).toEqual(['art_1']);
  });

  test('file names, emails, hosts and paths are split into words, as the query is', async () => {
    const h = await open('art_1', 'art_2', 'art_3', 'art_4');
    await searchUpsert(h, { artifactId: 'art_1', name: 'dashboard.html', tags: '', body: '' });
    await searchUpsert(h, {
      artifactId: 'art_2',
      name: 'Contacts',
      tags: '',
      body: 'Write to ops@example.com',
    });
    await searchUpsert(h, {
      artifactId: 'art_3',
      name: 'Guide',
      tags: '',
      body: 'See /docs/setup',
    });
    await searchUpsert(h, {
      artifactId: 'art_4',
      name: 'report_final.v2.html',
      tags: 'chup.vn',
      body: 'https://chup.vn/anh-dep?x=1',
    });

    expect(await searchQuery(h, 'dashboard', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'dashboard.html', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'example', 10)).toEqual(['art_2']);
    expect(await searchQuery(h, 'ops@example.com', 10)).toEqual(['art_2']);
    expect(await searchQuery(h, 'setup', 10)).toEqual(['art_3']);
    expect(await searchQuery(h, 'docs', 10)).toEqual(['art_3']);
    expect(await searchQuery(h, 'final v2', 10)).toEqual(['art_4']);
    expect(await searchQuery(h, 'anh dep', 10)).toEqual(['art_4']);
    expect(await searchQuery(h, 'chup', 10)).toEqual(['art_4']);
  });

  test('operator words in the query are plain words', async () => {
    const h = await open('art_1');
    await searchUpsert(h, {
      artifactId: 'art_1',
      name: '',
      tags: '',
      body: 'rock and roll or not',
    });
    expect(await searchQuery(h, 'ROCK AND', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'NOT roll', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'rock OR jazz', 10)).toEqual([]);
  });

  test('upsert replaces the previous entry', async () => {
    const h = await open('art_1');
    await searchUpsert(h, {
      artifactId: 'art_1',
      name: 'Old title',
      tags: 'draft',
      body: 'shared',
    });
    await searchUpsert(h, {
      artifactId: 'art_1',
      name: 'New title',
      tags: 'final',
      body: 'shared',
    });
    expect(await searchQuery(h, 'old', 10)).toEqual([]);
    expect(await searchQuery(h, 'draft', 10)).toEqual([]);
    expect(await searchQuery(h, 'new final', 10)).toEqual(['art_1']);
    expect(await searchQuery(h, 'shared', 10)).toEqual(['art_1']);
  });

  test('ranks better matches first and honours the limit', async () => {
    const h = await open('art_1', 'art_2', 'art_3');
    await searchUpsert(h, {
      artifactId: 'art_1',
      name: 'Studio',
      tags: '',
      body: 'Studio chụp ảnh cưới, quay phim và in album cho gia đình',
    });
    await searchUpsert(h, { artifactId: 'art_2', name: 'Ảnh', tags: 'ảnh', body: 'ảnh ảnh ảnh' });
    await searchUpsert(h, { artifactId: 'art_3', name: 'Menu', tags: '', body: 'cà phê' });
    expect(await searchQuery(h, 'anh', 10)).toEqual(['art_2', 'art_1']);
    expect(await searchQuery(h, 'anh', 1)).toEqual(['art_2']);
    expect(await searchQuery(h, 'anh', 0)).toEqual([]);
    await expect(searchQuery(h, 'anh', -1)).rejects.toThrow(RangeError);
  });

  test("search writes join the caller's transaction", async () => {
    const h = await open('art_1', 'art_2');
    await searchUpsert(h, { artifactId: 'art_1', name: 'Kept', tags: '', body: '' });
    await expect(
      h.db.transaction().execute(async (trx) => {
        const scope = { db: trx, dialect: h.dialect };
        await searchUpsert(scope, { artifactId: 'art_2', name: 'Kept too', tags: '', body: '' });
        await searchDelete(scope, 'art_1');
        expect(await searchQuery(scope, 'kept', 10)).toEqual(['art_2']);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await searchQuery(h, 'kept', 10)).toEqual(['art_1']);
  });
});
