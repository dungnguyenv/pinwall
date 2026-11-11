/*
 * The Claude Code skill, read from the repository at build time. M6 writes
 * `skills/pinwall/SKILL.md`; until then the glob matches nothing and the
 * connect page leaves the skill out.
 */
const files = import.meta.glob<string>('../../../../../skills/pinwall/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The text of SKILL.md, or null when this build does not include it. */
export const skillText: string | null = Object.values(files)[0] ?? null;
