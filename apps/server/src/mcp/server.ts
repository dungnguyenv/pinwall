import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import packageJson from '../../package.json' with { type: 'json' };
import type { AppEnv, AuthContext } from '../app.ts';
import type { AppDeps } from '../deps.ts';
import { registerIdentityTools } from './tools/identity.ts';
import { libraryTools } from './tools/library.ts';
import { publishTools } from './tools/publish.ts';

/** What every tool of one `/mcp` request acts with: the caller, resolved before the server exists. */
export interface ToolContext {
  deps: AppDeps;
  auth: AuthContext;
  c: Context<AppEnv>;
}

/** Every tool `/mcp` serves once M6 is complete; the skill and the docs name these. */
export const TOOL_NAMES = [
  'whoami',
  'list_projects',
  'get_project',
  'create_project',
  'list_artifacts',
  'search_artifacts',
  'get_artifact',
  'create_publish_session',
  'publish_inline',
  'list_comments',
  'reply_to_comment',
  'resolve_comment',
  'create_share_link',
  'list_share_links',
  'revoke_share_link',
] as const;

/** Sent to the client at `initialize`; agents read it before choosing a tool. */
export const SERVER_INSTRUCTIONS = [
  'Pinwall keeps the HTML pages, sites and Markdown documents you publish so people can review them and pin comments on them.',
  '1. Before publishing, call get_project (the project the user named, else the default one) and follow its instructions.',
  '2. Publish: if you can run shell commands, call create_publish_session and run the command it returns; otherwise call publish_inline.',
  '3. Answer with the review_url first.',
  '4. To address feedback: list_comments, fix the source, publish the next version with artifact_id and expected_version_id, then resolve_comment with the new version_id.',
  'Create share links only when the user asks for one.',
].join('\n');

/** Registers one group of tools on a request's server, closing over that request's caller. */
export type ToolModule = (server: McpServer, ctx: ToolContext) => void;

const TOOL_MODULES: readonly ToolModule[] = [registerIdentityTools, libraryTools, publishTools];

/**
 * A fresh MCP server for one `/mcp` request (the endpoint is stateless), with every tool bound
 * to `ctx`, so no tool can act for anyone but the request's caller.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'pinwall', title: 'Pinwall', version: packageJson.version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const register of TOOL_MODULES) register(server, ctx);
  return server;
}
