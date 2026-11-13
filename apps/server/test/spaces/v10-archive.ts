import { createHash } from 'node:crypto';
import type { Manifest, TableStats } from '../../src/ops/backup/format.ts';
import { readArchive, rewriteArchive } from '../helpers/backup.ts';

/** The tables `0003_spaces` added: a 1.0 archive has no entry for them. */
const NEW_TABLES = ['project_members', 'instance_settings'];
/** The columns `0003_spaces` added to tables a 1.0 archive has. */
const NEW_COLUMNS: Record<string, readonly string[]> = {
  users: ['share_approved', 'quota_bytes', 'quota_artifacts'],
  projects: ['owner_id'],
};

/**
 * A 1.1 archive made into what 1.0 wrote: no new tables or columns, migrations 0001–0002, stats
 * recomputed.
 */
export async function toV10Archive(buf: Buffer): Promise<Buffer> {
  const entries = await readArchive(buf);
  const rewritten = new Map<string, Buffer>();
  const stats: Record<string, TableStats> = {};
  for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
    const name = `tables/${table}.jsonl`;
    const entry = entries.find((e) => e.name === name);
    if (entry === undefined) throw new Error(`The archive has no ${name}`);
    const lines = entry.data
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        for (const column of columns) delete row[column];
        return `${JSON.stringify(row)}\n`;
      });
    const data = Buffer.from(lines.join(''), 'utf8');
    rewritten.set(name, data);
    stats[table] = {
      rows: lines.length,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }

  return rewriteArchive(buf, (e) => {
    if (NEW_TABLES.some((table) => e.name === `tables/${table}.jsonl`)) return null;
    const data = rewritten.get(e.name);
    if (data !== undefined) return { name: e.name, data };
    if (e.name !== 'manifest.json') return e;
    const manifest = JSON.parse(e.data.toString('utf8')) as Manifest;
    const tables: Record<string, TableStats> = { ...manifest.tables, ...stats };
    for (const table of NEW_TABLES) delete tables[table];
    const v10 = { ...manifest, migrations: ['0001_initial', '0002_publishing'], tables };
    return { name: e.name, data: Buffer.from(`${JSON.stringify(v10, null, 2)}\n`, 'utf8') };
  });
}
