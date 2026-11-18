import { z } from 'zod';
import { effectiveRole } from '../../auth/roles.ts';
import type { Config } from '../../config/types.ts';
import { mayExpose } from '../../domain/exposure.ts';
import { limitsOf, quotaApplies, usageOf } from '../../domain/usage.ts';
import { t } from '../../lib/i18n.ts';
import { DESCRIPTIONS } from '../descriptions.ts';
import { formatBytes } from '../format.ts';
import { runTool } from '../results.ts';
import type { ToolContext, ToolModule } from '../server.ts';
import type { WhoamiOut } from '../types.ts';

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

async function whoami({ deps, auth }: ToolContext): Promise<WhoamiOut> {
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
    limits: { max_upload_bytes: limits.maxUploadBytes, max_inline_bytes: limits.maxInlineBytes },
    authoring_notes: authoringNotes(config),
    // The fields below are shown only when their setting is not at its 1.0 default.
    ...(quotaApplies(config, user)
      ? { usage: await usageOf(deps.db.db, config, user.id), quota: limitsOf(config, user) }
      : {}),
    ...(config.shareLinks === 'approved'
      ? { can_create_share_links: mayExpose(config, user) }
      : {}),
  };
}

/** "no limit" for a limit that is null, else `show` of it. */
const limitText = (limit: number | null, show: (n: number) => string = String) =>
  limit === null ? t('mcp.whoami.noLimit') : show(limit);

/** The lines `whoami` adds under the authoring notes: the caller's space, and a refused permission. */
function accountLines({ usage, quota, can_create_share_links }: WhoamiOut): string[] {
  const lines: string[] = [];
  if (usage !== undefined && quota !== undefined) {
    lines.push(
      t('mcp.whoami.space', {
        bytes: formatBytes(usage.bytes),
        bytesLimit: limitText(quota.bytes, formatBytes),
        artifacts: usage.artifacts,
        artifactsLimit: limitText(quota.artifacts),
        files: usage.files,
        filesLimit: limitText(quota.files),
      }),
    );
  }
  if (can_create_share_links === false) lines.push(t('mcp.whoami.noShareLinks'));
  return lines;
}

/** `whoami`: the caller, how they connected, and what this Pinwall accepts. */
export const registerIdentityTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'whoami',
    {
      ...DESCRIPTIONS.whoami,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runTool(ctx, async () => {
      const me = await whoami(ctx);
      const { user } = me;
      const summary = t('mcp.whoami.text', {
        url: me.pinwall_url,
        // A person without a name is known by their email, else by their id.
        name: user.name ?? user.email ?? user.id,
        role: user.role,
        via: me.via,
        isolation: me.isolation,
        upload: formatBytes(me.limits.max_upload_bytes),
        inline: formatBytes(me.limits.max_inline_bytes),
      });
      const notes = me.authoring_notes.map((note) => `- ${note}`);
      return [summary, ...notes, ...accountLines(me)].join('\n');
    }),
  );
};
