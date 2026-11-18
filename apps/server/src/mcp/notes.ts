import type { Config } from '../config/types.ts';
import { t } from '../lib/i18n.ts';

/**
 * How published pages behave here: always the entry, link and completeness rules, then what the
 * isolation mode means for a page's storage.
 */
export function authoringNotes(config: Config): string[] {
  return [
    t('mcp.notes.entry'),
    t('mcp.notes.relativeLinks'),
    t('mcp.notes.selfContained'),
    config.isolation.mode === 'single-domain'
      ? t('mcp.notes.opaqueOrigin')
      : t('mcp.notes.perVersionOrigin'),
  ];
}
