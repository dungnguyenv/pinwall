import { z } from 'zod';
import { effectiveRole } from '../../auth/roles.ts';
import type { Config } from '../../config/types.ts';
import { t } from '../../lib/i18n.ts';
import { DESCRIPTIONS } from '../descriptions.ts';
import { formatBytes } from '../format.ts';
import { runTool } from '../results.ts';
import { WhoamiOut } from '../schemas.ts';
import type { ToolContext, ToolModule } from '../server.ts';

/**
 * How published pages behave here: always the entry, link and completeness rules, then what the
 * isolation mode means for a page's storage.
 */
function authoringNotes(config: Config): string[] {
  return [
    t('mcp.notes.entry'),
    t('mcp.notes.relativeLinks'),
    t('mcp.notes.selfContained'),
    config.isolation.mode === 'single-domain'
      ? t('mcp.notes.opaqueOrigin')
      : t('mcp.notes.perVersionOrigin'),
  ];
}

function whoami({ deps, auth }: ToolContext): WhoamiOut {
  const { user } = auth;
  const role = effectiveRole(user);
  // `resolveAuth` admits only members and admins, and `/mcp` never reads a session cookie.
  if (role !== 'admin' && role !== 'member') throw new Error(`whoami: no access role (${role})`);
  if (auth.via === 'session') throw new Error('whoami: /mcp is bearer only');
  const { config } = deps;
  const { limits } = config;
  return {
    user: { id: user.id, name: user.name, email: user.email, role },
    via: auth.via,
    pinwall_url: config.publicOrigin,
    isolation: config.isolation.mode,
    limits: {
      max_upload_bytes: limits.maxUploadBytes,
      max_inline_bytes: limits.maxInlineBytes,
      max_file_bytes: limits.maxFileBytes,
      max_version_bytes: limits.maxVersionBytes,
      max_files: limits.maxFiles,
    },
    upload_url_ttl_seconds: Math.floor(config.ttl.uploadSessionMs / 1000),
    authoring_notes: authoringNotes(config),
  };
}

/** `whoami`: the caller, how they connected, and what this Pinwall accepts. */
export const registerIdentityTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'whoami',
    {
      ...DESCRIPTIONS.whoami,
      inputSchema: z.object({}),
      outputSchema: WhoamiOut,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(ctx, async () => {
      const structured = whoami(ctx);
      const { user } = structured;
      const summary = t('mcp.whoami.text', {
        url: structured.pinwall_url,
        // A person without a name is known by their email, else by their id.
        name: user.name ?? user.email ?? user.id,
        role: user.role,
        via: structured.via,
        isolation: structured.isolation,
        upload: formatBytes(structured.limits.max_upload_bytes),
        inline: formatBytes(structured.limits.max_inline_bytes),
      });
      const notes = structured.authoring_notes.map((note) => `- ${note}`);
      return { text: [summary, ...notes].join('\n'), structured };
    }),
  );
};
