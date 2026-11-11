import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { startAuth } from './auth/startup.ts';
import { type Config, ConfigError, loadConfig } from './config/load.ts';
import { connectDb } from './db/connect.ts';
import { migrateToLatest } from './db/migrate.ts';
import { closeDeps, createDeps } from './deps.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { startPublishing } from './publish/startup.ts';
import { configureServerForUploads } from './publish/upload-route.ts';

const USAGE = `Usage: pinwall [command]

Commands:
  serve     Run the server (the default). Applies pending migrations first.
  migrate   Apply pending database migrations, then exit.

Configuration comes from PINWALL_* environment variables.`;

/** Exit code for a bad command line or configuration: the operator has to change something. */
const EXIT_USAGE = 2;
/** After a stop signal, open connections get this long to finish before they are cut. */
const DRAIN_MS = 5_000;
/** After a stop signal, the process exits by this time even if closing hangs. */
const SHUTDOWN_DEADLINE_MS = 10_000;

type Command = 'serve' | 'migrate' | 'help';

/** The command, or an error message for a command line that is not understood. */
function parseCommand(argv: string[]): Command | { error: string } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) return 'help';
    const [command = 'serve', ...rest] = positionals;
    if (rest.length > 0) return { error: `Unexpected argument: ${rest.join(' ')}` };
    if (command === 'serve' || command === 'migrate' || command === 'help') return command;
    return { error: `Unknown command: ${command}` };
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

async function main(argv: string[]): Promise<void> {
  const command = parseCommand(argv);
  if (typeof command === 'object') {
    console.error(`${command.error}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }
  if (command === 'help') {
    console.log(USAGE);
    return;
  }

  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) exitWithConfigError(error);
    throw error;
  }

  const logger = createLogger(config.logLevel);
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'Unhandled promise rejection');
    process.exit(1);
  });

  try {
    if (command === 'migrate') await migrate(config, logger);
    else await runServer(config, logger);
  } catch (error) {
    // `ensureSecretKey` reports an unusable key file as a ConfigError too.
    if (error instanceof ConfigError) exitWithConfigError(error);
    logger.fatal(
      { err: error },
      command === 'migrate' ? 'Migration failed' : 'Pinwall cannot start',
    );
    process.exit(1);
  }
}

await main(process.argv.slice(2));
