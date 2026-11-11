/**
 * The title and description each MCP tool is listed with. They are protocol text for the model
 * that calls the tools, not UI copy, so they stay here as constants rather than in `en.json`.
 * Tool modules register under the same keys.
 */
export const DESCRIPTIONS = {
  whoami: {
    title: 'Who am I',
    description:
      'Shows which Pinwall account this connection acts as (name, email, role) and whether it ' +
      'signed in with OAuth or an API token, the address of this Pinwall, its isolation mode, ' +
      'the size limits for one publish, for an inline publish, for one file and for one ' +
      'version, the most files a version may hold, how long an upload URL stays valid, and ' +
      'notes on writing pages that work once published. Call it when you need those limits or ' +
      'are unsure which account you are using.',
  },
} as const;
