import { z } from 'zod';

/** The groups the admin configuration view shows, in display order. */
export const ConfigSection = z.enum([
  'general',
  'isolation',
  'database',
  'storage',
  'sign_in',
  'access',
  'spaces',
  'limits',
  'lifetimes',
]);
export type ConfigSection = z.infer<typeof ConfigSection>;

/** One effective setting, named by the environment variable that sets it. */
export const ConfigEntry = z.object({
  section: ConfigSection,
  env: z.string(),
  /** The value as it would be written in the environment; `null` when not set. Always `null` for a secret. */
  value: z.string().nullable(),
  secret: z.boolean(),
  /** Whether the setting has a value; for a secret, the only thing shown about it. */
  set: z.boolean(),
});
export type ConfigEntry = z.infer<typeof ConfigEntry>;

/** The effective configuration, read-only: environment variables are its only source. */
export const AdminConfig = z.object({
  isolation: z.enum(['single-domain', 'content-domain']),
  /** The content origin in `content-domain` mode, e.g. `https://pinwall-content.example`. */
  content_origin: z.string().nullable(),
  entries: z.array(ConfigEntry),
  /** Non-fatal configuration problems the server also logs at start. */
  warnings: z.array(z.string()),
});
export type AdminConfig = z.infer<typeof AdminConfig>;
