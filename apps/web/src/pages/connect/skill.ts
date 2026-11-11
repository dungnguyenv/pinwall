/*
 * The Claude Code skill, `skills/pinwall/SKILL.md`, read from the repository
 * at build time. A build without that file leaves the skill off the connect
 * page.
 */
const files = import.meta.glob<string>('../../../../../skills/pinwall/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The text of SKILL.md, or null when this build does not include it. */
export const skillText: string | null = Object.values(files)[0] ?? null;
