import type { Context } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import { versionConflict } from '../../src/domain/versions.ts';
import { AppError, forbidden, notFound } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { formatBytes } from '../../src/mcp/format.ts';
import { runTool, toolError } from '../../src/mcp/results.ts';
import type { ToolContext } from '../../src/mcp/server.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

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

test('runTool answers text plus structured content, or the tool error', async () => {
  const double = runTool(toolCtx, async (args: { n: number }) => ({
    text: `Twice ${args.n} is ${2 * args.n}.`,
    structured: { result: 2 * args.n },
  }));
  expect(await double({ n: 21 })).toEqual({
    content: [{ type: 'text', text: 'Twice 21 is 42.' }],
    structuredContent: { result: 42 },
  });

  const missing = runTool(toolCtx, async (_args: Record<string, never>) => {
    throw notFound('No artifact art_1.');
  });
  expect(await missing({})).toEqual(textError(`No artifact art_1.\n${t('mcp.hint.not_found')}`));
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
