/** The name each agent knows Pinwall's MCP server by. */
const SERVER_NAME = 'pinwall';

/** Signs Codex in to the server that `connectSnippets(…).codex` adds. */
export const CODEX_SIGN_IN = `codex mcp login ${SERVER_NAME}`;

/** Moves a downloaded SKILL.md to where Claude Code looks for personal skills. */
export const SKILL_INSTALL = `mkdir -p ~/.claude/skills/${SERVER_NAME} && mv ~/Downloads/SKILL.md ~/.claude/skills/${SERVER_NAME}/`;

/**
 * The setup each agent needs to reach the Pinwall at `origin`: the MCP
 * address, Claude Code's command, Cursor's `mcp.json` and Codex's
 * `config.toml` entry. Each agent signs in with OAuth on first use.
 */
export function connectSnippets(origin: string): {
  mcpUrl: string;
  claudeCode: string;
  cursor: string;
  codex: string;
} {
  const mcpUrl = new URL('/mcp', origin).href;
  return {
    mcpUrl,
    claudeCode: `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl}`,
    cursor: JSON.stringify({ mcpServers: { [SERVER_NAME]: { url: mcpUrl } } }, null, 2),
    // A JSON string is a valid TOML basic string for any URL.
    codex: `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(mcpUrl)}`,
  };
}
