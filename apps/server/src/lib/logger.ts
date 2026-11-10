import { type DestinationStream, type LevelWithSilent, pino } from 'pino';

export type Logger = pino.Logger;

/** Keys whose values never reach a log line, at the top level and one level down. */
const CREDENTIAL_KEYS = [
  'authorization',
  'cookie',
  '["set-cookie"]',
  'password',
  'token',
  'secret',
];
const REDACT_PATHS = CREDENTIAL_KEYS.flatMap((key) => [
  key,
  key.startsWith('[') ? `*${key}` : `*.${key}`,
]);

/**
 * Structured JSON logs, one object per line, to stdout unless `destination` is given. Levels are
 * written by name and times as ISO 8601; credentials are replaced with `[redacted]`.
 */
export function createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
