import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { ToolContext } from './server.ts';

/** What a tool hands back: a compact text for the model, and the data its output schema names. */
export interface ToolOutput<T> {
  text: string;
  structured: T;
}

/** `t(key)`, or null when `en.json` has no such key. */
function optionalMessage(key: string): string | null {
  const message = t(key);
  return message === key ? null : message;
}

/**
 * A failed tool call as the model sees it (`isError`, so it can correct course rather than the
 * call failing at the protocol level). A 4xx `AppError` shows its message, then the next step
 * for its code (`mcp.hint.<code>`) when there is one, then its details as JSON. Anything else is
 * logged in full and answered with a generic message naming only the request id.
 */
export function toolError(ctx: ToolContext, err: unknown): CallToolResult {
  if (err instanceof AppError && err.status >= 400 && err.status < 500) {
    const lines = [err.message];
    const hint = optionalMessage(`mcp.hint.${err.code}`);
    if (hint !== null) lines.push(hint);
    if (err.details !== undefined) {
      lines.push(t('mcp.error.details', { details: JSON.stringify(err.details) }));
    }
    return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
  }
  const requestId = ctx.c.var.requestId;
  ctx.deps.logger.error({ err, request_id: requestId }, 'MCP tool failed with an unexpected error');
  return {
    isError: true,
    content: [{ type: 'text', text: t('mcp.error.internal', { requestId }) }],
  };
}

/**
 * Wraps a tool's work into an SDK tool callback: its output becomes one text block plus
 * `structuredContent`, and whatever it throws becomes `toolError`.
 */
export function runTool<A, T extends Record<string, unknown>>(
  ctx: ToolContext,
  fn: (args: A) => Promise<ToolOutput<T>>,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      const { text, structured } = await fn(args);
      return { content: [{ type: 'text', text }], structuredContent: structured };
    } catch (err) {
      return toolError(ctx, err);
    }
  };
}
