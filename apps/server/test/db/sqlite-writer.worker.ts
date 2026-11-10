// Worker thread for `two handles on one file can both write`: opens a second DbHandle on the
// same SQLite file and keeps a write transaction open for `holdMs` before committing.
// Node loads this file directly (type stripping), so it uses erasable TypeScript only.
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { connectDb } from '../../src/db/connect.ts';

const { path, holdMs } = workerData as { path: string; holdMs: number };
const handle = await connectDb({ kind: 'sqlite', path });
await handle.db.transaction().execute(async (trx) => {
  await trx
    .insertInto('leases')
    .values({ name: 'worker', holder: 'worker', expires_at: 1 })
    .execute();
  parentPort?.postMessage('locked');
  await sleep(holdMs);
});
await handle.close();
parentPort?.postMessage('done');
