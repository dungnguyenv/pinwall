// Child process for `two processes migrating one fresh file at once`: prints "ready" once loaded,
// waits for a line on stdin, then opens the SQLite file named by the first argument, migrates it
// and prints the applied migrations as JSON. Started together, two of these open and migrate
// within a millisecond of each other. Node runs this file directly (type stripping), so it uses
// erasable TypeScript only.
import { once } from 'node:events';
import { connectDb } from '../../src/db/connect.ts';
import { migrateToLatest } from '../../src/db/migrate.ts';

const path = process.argv[2];
if (!path) throw new Error('usage: node sqlite-migrator.child.ts <database file>');

process.stdout.write('ready\n');
await once(process.stdin, 'data');
process.stdin.destroy();

const handle = await connectDb({ kind: 'sqlite', path });
try {
  const applied = await migrateToLatest(handle);
  process.stdout.write(`${JSON.stringify({ applied })}\n`);
} finally {
  await handle.close();
}
