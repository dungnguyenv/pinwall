/**
 * Every TanStack Query key the app uses, so invalidations and cache writes
 * name the same keys as the queries they target. Each screen adds its keys
 * here rather than spelling them inline.
 */
export const qk = {
  me: ['me'] as const,
  publicConfig: ['config', 'public'] as const,
};
