import { Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { createLogger } from '../../src/lib/logger.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { lines, stream };
}

test('logs one JSON object per line with a level name and an ISO time', () => {
  const { lines, stream } = capture();
  const logger = createLogger('info', stream);
  logger.info({ port: 8080 }, 'listening');
  logger.debug('hidden below the level');

  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ level: 'info', msg: 'listening', port: 8080 });
  expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('redacts credentials, at the top level and one level down', () => {
  const { lines, stream } = capture();
  const logger = createLogger('info', stream);
  logger.info(
    {
      authorization: 'Bearer pw_top',
      cookie: 'pinwall_session=top',
      'set-cookie': 'pinwall_session=top',
      headers: {
        authorization: 'Bearer pw_nested',
        cookie: 'pinwall_session=nested',
        'set-cookie': 'pinwall_session=nested',
      },
      body: { password: 'hunter2', token: 'tok', secret: 'shh', name: 'kept' },
    },
    'request',
  );

  const text = JSON.stringify(lines[0]);
  for (const leaked of ['pw_top', 'pw_nested', 'pinwall_session=', 'hunter2', '"tok"', 'shh']) {
    expect(text).not.toContain(leaked);
  }
  expect(lines[0]).toMatchObject({ body: { password: '[redacted]', name: 'kept' } });
});

test('a silent logger writes nothing', () => {
  const { lines, stream } = capture();
  createLogger('silent', stream).error('nothing');
  expect(lines).toHaveLength(0);
});
