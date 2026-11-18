import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { ToolContext } from './server.ts';

/** `t(key)`, or null when `en.json` has no such key. */
function optionalMessage(key: string): string | null {
  const message = t(key);
  return message === key ? null : message;
}

/**
 * The next step for an error: the hint for its `details.reason` (`mcp.hint.<code>.<reason>`)
 * when it names one and `en.json` has it, else the hint for its code (`mcp.hint.<code>`).
 */
function hintFor(err: AppError): string | null {
  const reason = err.details?.reason;
  const forReason =
    typeof reason === 'string' ? optionalMessage(`mcp.hint.${err.code}.${reason}`) : null;
  return forReason ?? optionalMessage(`mcp.hint.${err.code}`);
}

/** A client error: a 4xx `AppError`, whose message is meant to be read by the caller. */
function isClientError(err: unknown): err is AppError {
  return err instanceof AppError && err.status >= 400 && err.status < 500;
}

/** Logs an unexpected error in full and answers with the generic text naming only the request id. */
function internalMessage(ctx: ToolContext, err: unknown): string {
  const requestId = ctx.c.var.requestId;
  ctx.deps.logger.error({ err, request_id: requestId }, 'MCP tool failed with an unexpected error');
  return t('mcp.error.internal', { requestId });
}

/** A failed tool call whose text the tool wrote itself: `isError`, so the model can correct course. */
export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * A failed tool call as the model sees it (`isError`, so it can correct course rather than the
 * call failing at the protocol level). A 4xx `AppError` shows its message, then the next step
 * for its reason or code when there is one, then its details as JSON, then `appendix` (what the
 * caller needs to recover, such as a diff to merge) when there is one. Anything else is logged
 * in full and answered with a generic message naming only the request id.
 */
export function toolError(
  ctx: ToolContext,
  err: unknown,
  appendix: string | null = null,
): CallToolResult {
  if (!isClientError(err)) return errorResult(internalMessage(ctx, err));
  const lines = [err.message];
  const hint = hintFor(err);
  if (hint !== null) lines.push(hint);
  if (err.details !== undefined) {
    lines.push(t('mcp.error.details', { details: JSON.stringify(err.details) }));
  }
  if (appendix !== null) lines.push(appendix);
  return errorResult(lines.join('\n'));
}

/**
 * A failure as one short text, for a line of a result that reports on several items: a 4xx
 * `AppError`'s message alone, without `toolError`'s hint and details, which would repeat for every
 * item. Anything else is logged in full and answered with the generic message naming only the
 * request id, as `toolError` does.
 */
export function errorMessage(ctx: ToolContext, err: unknown): string {
  return isClientError(err) ? err.message : internalMessage(ctx, err);
}

/**
 * Wraps a tool's work into an SDK tool callback: the text it returns becomes the one text block
 * of the result (no `structuredContent`, which clients would show the model instead of the
 * text), a result it returns (`errorResult`) is answered as it is, and whatever it throws becomes
 * `toolError`. `appendix` runs for a thrown error and may return more text to end the error with;
 * when it fails itself, the error is answered without it.
 */
export function runTool<A>(
  ctx: ToolContext,
  fn: (args: A) => Promise<string | CallToolResult>,
  opts: { appendix?: (err: unknown, args: A) => Promise<string | null> } = {},
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      const out = await fn(args);
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
    } catch (err) {
      let appendix: string | null = null;
      try {
        appendix = (await opts.appendix?.(err, args)) ?? null;
      } catch (appendixErr) {
        ctx.deps.logger.error(
          { err: appendixErr, request_id: ctx.c.var.requestId },
          'MCP tool error appendix failed',
        );
      }
      return toolError(ctx, err, appendix);
    }
  };
}
