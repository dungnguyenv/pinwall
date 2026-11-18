import type { Context } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import { versionConflict } from '../../src/domain/versions.ts';
import { AppError, conflict, forbidden, notFound } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { formatBytes } from '../../src/mcp/format.ts';
import { errorMessage, errorResult, runTool, toolError } from '../../src/mcp/results.ts';
import type { ToolContext } from '../../src/mcp/server.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { toolText } from '../helpers/mcp.ts';

const REQUEST_ID = 'req_test';

let ctx: TestContext;
let toolCtx: ToolContext;
beforeAll(async () => {
  ctx = await createTestContext();
  const { user } = await createSignedInUser(ctx);
  // Tool results read only the request id from the request context.
  const c = { var: { requestId: REQUEST_ID } } as unknown as Context<AppEnv>;
  toolCtx = { deps: ctx.deps, auth: { user, via: 'api_token' }, c };
});
afterAll(() => ctx?.close());

const textError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });

test('an AppError becomes an actionable tool error', () => {
  const err = versionConflict({ id: 'ver_2', number: 2 });
  expect(toolError(toolCtx, err)).toEqual(
    textError(
      `${err.message}\n${t('mcp.hint.version_conflict')}\n` +
        'Details: {"current_version_id":"ver_2","current_version_number":2}',
    ),
  );
  // No hint for the code and no details: the message alone.
  expect(toolError(toolCtx, forbidden('Not yours.'))).toEqual(textError('Not yours.'));
});

test('a reason hint comes before the code hint', () => {
  // en.json has mcp.hint.conflict.edited_on_server and no mcp.hint.conflict.
  const r = toolError(toolCtx, conflict('m', { reason: 'edited_on_server' }), 'APPENDIX');
  expect(toolText(r).split('\n')).toEqual([
    'm',
    t('mcp.hint.conflict.edited_on_server'),
    expect.stringMatching(/^Details: /),
    'APPENDIX',
  ]);
});

test('a role refusal and a share refusal before approval say that they are final', () => {
  for (const reason of ['role', 'share_links_not_approved']) {
    const lines = toolText(toolError(toolCtx, forbidden('m', { reason }))).split('\n');
    expect(lines[1], reason).toBe(t(`mcp.hint.forbidden.${reason}`));
    expect(lines[1], reason).toMatch(/^Do not retry/);
  }
});

test('unexpected errors are logged and hidden', () => {
  const logged = vi.spyOn(ctx.deps.logger, 'error');
  const internal = t('mcp.error.internal', { requestId: REQUEST_ID });
  const err = new Error('db password leaked');
  const r = toolError(toolCtx, err);
  expect(r).toEqual(textError(internal));
  expect(JSON.stringify(r)).not.toContain('leaked');
  expect(logged).toHaveBeenCalledOnce();
  expect(logged.mock.calls[0]?.[0]).toMatchObject({ err, request_id: REQUEST_ID });

  // A server-side AppError is no message for the agent either.
  const fault = new AppError('internal', 500, 'pool exhausted');
  expect(toolError(toolCtx, fault)).toEqual(textError(internal));
  expect(logged).toHaveBeenCalledTimes(2);
  logged.mockRestore();
});

test('errorMessage is the message of a client error, alone', () => {
  const err = versionConflict({ id: 'ver_2', number: 2 });
  // Neither the hint nor the details of toolError: a line of a batch result, not a whole answer.
  expect(errorMessage(toolCtx, err)).toBe(err.message);
  expect(errorMessage(toolCtx, notFound('No comment.'))).toBe('No comment.');
});

test('errorMessage logs an unexpected error and hides it', () => {
  const logged = vi.spyOn(ctx.deps.logger, 'error');
  const internal = t('mcp.error.internal', { requestId: REQUEST_ID });
  const err = new Error('db password leaked');
  expect(errorMessage(toolCtx, err)).toBe(internal);
  expect(logged).toHaveBeenCalledOnce();
  expect(logged.mock.calls[0]?.[0]).toMatchObject({ err, request_id: REQUEST_ID });
  expect(errorMessage(toolCtx, new AppError('internal', 500, 'pool exhausted'))).toBe(internal);
  expect(logged).toHaveBeenCalledTimes(2);
  logged.mockRestore();
});

test('a tool may answer with an error result of its own text', async () => {
  expect(errorResult('Resolved 0 of 1 threads.')).toEqual(textError('Resolved 0 of 1 threads.'));
  const run = runTool(toolCtx, async (_args: Record<string, never>) => errorResult('As written.'));
  expect(await run({})).toEqual(textError('As written.'));
});

test('runTool answers one text block, or the tool error', async () => {
  const double = runTool(
    toolCtx,
    async (args: { n: number }) => `Twice ${args.n} is ${2 * args.n}.`,
  );
  expect(await double({ n: 21 })).toEqual({
    content: [{ type: 'text', text: 'Twice 21 is 42.' }],
  });

  const missing = runTool(toolCtx, async (_args: Record<string, never>): Promise<string> => {
    throw notFound('No artifact art_1.');
  });
  expect(await missing({})).toEqual(textError(`No artifact art_1.\n${t('mcp.hint.not_found')}`));
});

test('runTool ends an error with what its appendix says, when it says something', async () => {
  const fails = async (_args: { n: number }): Promise<string> => {
    throw conflict('Stale.', { reason: 'edited_on_server' });
  };
  const seen: unknown[] = [];
  const withAppendix = runTool(toolCtx, fails, {
    appendix: async (err, args) => {
      seen.push([err instanceof AppError, args]);
      return 'DIFF';
    },
  });
  const lines = toolText(await withAppendix({ n: 1 })).split('\n');
  expect(lines.at(-1)).toBe('DIFF');
  expect(seen).toEqual([[true, { n: 1 }]]);

  // An appendix of null adds nothing.
  const silent = runTool(toolCtx, fails, { appendix: async () => null });
  expect(toolText(await silent({ n: 1 })).split('\n')).toHaveLength(3);
  expect(await runTool(toolCtx, fails)({ n: 1 })).toEqual(await silent({ n: 1 }));
});

test('runTool answers the error without the appendix when the appendix itself fails', async () => {
  const logged = vi.spyOn(ctx.deps.logger, 'error');
  const run = runTool(
    toolCtx,
    async (_args: Record<string, never>): Promise<string> => {
      throw notFound('No artifact art_1.');
    },
    {
      appendix: async () => {
        throw new Error('blob store down');
      },
    },
  );
  expect(await run({})).toEqual(textError(`No artifact art_1.\n${t('mcp.hint.not_found')}`));
  expect(logged).toHaveBeenCalledOnce();
  logged.mockRestore();
});

test('formatBytes', () => {
  expect(formatBytes(2_000_000)).toBe('2 MB');
  expect(formatBytes(95_000_000)).toBe('95 MB');
  expect(formatBytes(500_000)).toBe('500 KB');
  expect(formatBytes(1_500)).toBe('1.5 KB');
  expect(formatBytes(999)).toBe('999 bytes');
  // Rounding up to the next unit names that unit.
  expect(formatBytes(999_960)).toBe('1 MB');
});
