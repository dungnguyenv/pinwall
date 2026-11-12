// Child process for `a connection lost … fails its transaction, is logged once and is replaced`.
// It opens the Postgres database at the URL in the first argument and ends the backend of an
// open transaction with pg_terminate_backend, either while that transaction runs a query
// (`query`) or while it waits between two statements (`idle`). Then it prints one JSON line:
// how the transaction ended, what the logger received, and the answer to the next query. A
// connection error that nobody listens for ends the process before it prints. Node runs this
// file directly (type stripping), so it uses erasable TypeScript only.
import { sql } from 'kysely';
import { connectDb } from '../../src/db/connect.ts';

const [url, mode] = process.argv.slice(2);
if (url === undefined || (mode !== 'query' && mode !== 'idle')) {
  throw new Error('usage: node pg-connection-loss.child.ts <database url> query|idle');
}

/** How long any wait below may take before the child gives up and reports what it has. */
const WAIT_MS = 5_000;

const logged: { fields: object; message: string }[] = [];
const h = await connectDb(
  { kind: 'postgres', url, poolSize: 2 },
  { error: (fields, message) => logged.push({ fields, message }) },
);

/** Polls `done` every 10 ms until it is true or `WAIT_MS` has passed. */
async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await done()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The state of backend `pid` (`active` while it runs a query), or null once it is gone. */
async function stateOf(pid: number): Promise<string | null> {
  // Through the pool's other connection: the transaction holds the first one.
  const { rows } = await sql<{ state: string | null }>`
    select state from pg_stat_activity where pid = ${pid}
  `.execute(h.db);
  return rows.length === 0 ? null : (rows[0]?.state ?? 'starting');
}

let transaction: string;
try {
  await h.db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    if (mode === 'query') {
      const running = sql`select pg_sleep(30)`.execute(trx);
      running.catch(() => {}); // awaited below
      await until(async () => (await stateOf(pid)) === 'active');
      await sql`select pg_terminate_backend(${pid})`.execute(h.db);
      await running;
    } else {
      await sql`select pg_terminate_backend(${pid})`.execute(h.db);
      // Waits until the client has read the server's goodbye, as other work (storing a blob)
      // would, so the next statement finds the connection already lost.
      await until(() => logged.length > 0);
      await sql`select 1`.execute(trx);
    }
  });
  transaction = 'committed';
} catch (error) {
  transaction = `rejected: ${(error as Error).message}`;
}
await until(() => logged.length > 0);

const next = await sql<{ one: number }>`select 1 as one`.execute(h.db);
await h.close();
process.stdout.write(`${JSON.stringify({ transaction, logged, next: next.rows[0]?.one })}\n`);
