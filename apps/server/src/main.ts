import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { buildApp } from './app.ts';
import { startAuth } from './auth/startup.ts';
import { type Config, ConfigError, loadConfig } from './config/load.ts';
import { connectDb } from './db/connect.ts';
import { migrateToLatest } from './db/migrate.ts';
import { closeDeps, createDeps } from './deps.ts';
import { t } from './lib/i18n.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { runBackupCommand, runRestoreCommand } from './ops/backup/cli.ts';
import { startPublishing } from './publish/startup.ts';
import { configureServerForUploads } from './publish/upload-route.ts';
import { PINWALL_VERSION } from './version.ts';

const USAGE = `Usage: pinwall [command]

Commands:
  serve                   Run the server (the default). Applies pending migrations first.
  migrate                 Apply pending database migrations, then exit.
  backup --out <file|->   Write a backup archive to a file, or to stdout with -
  restore --in <file|->   Restore an archive into an empty installation (- reads stdin)
  version                 Print the Pinwall version

Configuration comes from PINWALL_* environment variables.`;

/** Exit code for a bad command line or configuration: the operator has to change something. */
const EXIT_USAGE = 2;
/** After a stop signal, open connections get this long to finish before they are cut. */
const DRAIN_MS = 5_000;
/** After a stop signal, the process exits by this time even if closing hangs. */
const SHUTDOWN_DEADLINE_MS = 10_000;

type Command =
  | { name: 'serve' | 'migrate' | 'help' | 'version' }
  | { name: 'backup'; out: string }
  | { name: 'restore'; input: string };

/** The command, or an error message for a command line that is not understood. */
function parseCommand(argv: string[]): Command | { error: string } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        out: { type: 'string' },
        in: { type: 'string' },
      },
    });
    if (values.help) return { name: 'help' };
    if (values.version) return { name: 'version' };
    const [name = 'serve', ...rest] = positionals;
    if (rest.length > 0) return { error: `Unexpected argument: ${rest.join(' ')}` };

    // Each file option belongs to one command, which cannot do without it.
    if (values.out !== undefined && name !== 'backup') {
      return { error: '--out belongs to the backup command' };
    }
    if (values.in !== undefined && name !== 'restore') {
      return { error: '--in belongs to the restore command' };
    }
    if (name === 'backup' || name === 'restore') {
      const option = name === 'backup' ? '--out' : '--in';
      const path = name === 'backup' ? values.out : values.in;
      if (path === undefined || path === '') {
        return { error: `${name} needs ${option} <file|->` };
      }
      return name === 'backup' ? { name, out: path } : { name, input: path };
    }
    if (name === 'serve' || name === 'migrate' || name === 'help' || name === 'version') {
      return { name };
    }
    return { error: `Unknown command: ${name}` };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function originOf(o: { scheme: string; host: string; port?: number }): string {
  return `${o.scheme}://${o.host}${o.port === undefined ? '' : `:${o.port}`}`;
}

async function migrate(config: Config, logger: Logger): Promise<void> {
  const db = await connectDb(config.database, logger);
  try {
    const applied = await migrateToLatest(db);
    logger.info({ applied, database: config.database.kind }, 'migrated');
  } finally {
    await db.close();
  }
}

async function runServer(config: Config, logger: Logger): Promise<void> {
  for (const warning of config.warnings) logger.warn(warning);

  const deps = await createDeps(config, { logger });
  // Plain HTTP/1.1 (the adapter's default): TLS ends at the proxy in front of Pinwall.
  const server = serve({
    fetch: buildApp(deps).fetch,
    hostname: config.listen.host,
    port: config.listen.port,
  }) as Server;
  configureServerForUploads(server, config);

  let stopping = false;
  /** A startup step failed: log it and exit, once, unless a shutdown is already under way. */
  const cannotStart = (err: unknown) => {
    if (stopping) return;
    stopping = true;
    logger.fatal({ err }, 'Pinwall cannot start');
    void closeDeps(deps).finally(() => process.exit(1));
  };
  server.once('listening', () => {
    const { address, port } = server.address() as AddressInfo;
    const { isolation } = config;
    logger.info(
      {
        address,
        port,
        public_origin: config.publicOrigin,
        isolation: isolation.mode,
        ...(isolation.mode === 'content-domain'
          ? { content_origin: originOf(isolation.contentOrigin) }
          : {}),
        database: config.database.kind,
        storage: config.storage.kind,
      },
      'listening',
    );
    startAuth(deps).then((setupUrl) => {
      // Also as plain text, for someone watching `docker run` rather than reading JSON logs.
      if (setupUrl !== null) {
        console.error(`Pinwall setup: open ${setupUrl} to create the owner account`);
      }
    }, cannotStart);
    startPublishing(deps).catch(cannotStart);
  });
  server.once('error', (err) => {
    logger.fatal({ err }, 'The server cannot listen');
    void closeDeps(deps).finally(() => process.exit(1));
  });

  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      logger.warn({ signal }, 'Second stop signal: exiting now');
      process.exit(1);
    }
    stopping = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => {
      logger.error(`Shutdown took longer than ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    const drain = setTimeout(() => server.closeAllConnections(), DRAIN_MS).unref();
    // Live streams never finish by themselves: end them now, so `close` need not wait the drain.
    deps.liveStreams.closeAll();

    // `close` stops accepting connections; its callback runs once the open ones are done.
    server.close(() => {
      clearTimeout(drain);
      closeDeps(deps).then(
        () => {
          logger.info('stopped');
          process.exit(0);
        },
        (err: unknown) => {
          logger.error({ err }, 'Closing the database or the scheduler failed');
          process.exit(1);
        },
      );
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

/** A configuration problem is plain text on stderr, one issue per line: a person reads it. */
function exitWithConfigError(error: ConfigError): never {
  console.error(error.message);
  process.exit(EXIT_USAGE);
}

/** The text of whatever a failed command threw. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `backup` or `restore`. A failure is one plain line on stderr and exit code 1 (a
 * configuration problem is exit code 2, as everywhere); success leaves the process to end on
 * its own once the database is closed.
 */
async function runOperation(
  name: 'backup' | 'restore',
  logger: Logger,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) exitWithConfigError(error);
    logger.debug({ err: error }, `${name} failed`);
    console.error(t(`${name}.failed`, { message: messageOf(error) }));
    process.exit(1);
  }
}

async function main(argv: string[]): Promise<void> {
  const command = parseCommand(argv);
  if ('error' in command) {
    console.error(`${command.error}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }
  if (command.name === 'help') {
    console.log(USAGE);
    return;
  }
  if (command.name === 'version') {
    console.log(PINWALL_VERSION);
    return;
  }

  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) exitWithConfigError(error);
    throw error;
  }

  // stdout is the archive of `backup --out -`: these two commands log to stderr only.
  const logsToStderr = command.name === 'backup' || command.name === 'restore';
  const logger = createLogger(
    config.logLevel,
    logsToStderr ? pino.destination({ dest: 2, sync: true }) : undefined,
  );
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'Unhandled promise rejection');
    process.exit(1);
  });

  if (command.name === 'backup') {
    const { out } = command;
    await runOperation('backup', logger, () => runBackupCommand(config, logger, out));
    return;
  }
  if (command.name === 'restore') {
    const { input } = command;
    await runOperation('restore', logger, () => runRestoreCommand(config, logger, input));
    return;
  }

  try {
    if (command.name === 'migrate') await migrate(config, logger);
    else await runServer(config, logger);
  } catch (error) {
    // `ensureSecretKey` reports an unusable key file as a ConfigError too.
    if (error instanceof ConfigError) exitWithConfigError(error);
    logger.fatal(
      { err: error },
      command.name === 'migrate' ? 'Migration failed' : 'Pinwall cannot start',
    );
    process.exit(1);
  }
}

await main(process.argv.slice(2));
