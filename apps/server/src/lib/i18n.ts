import messages from '@pinwall/shared/i18n/en.json' with { type: 'json' };

const catalog: Readonly<Record<string, string>> = messages;

/**
 * Looks up an English UI string and fills `{{name}}` placeholders from `vars`.
 * A missing key returns the key itself; a placeholder without a value is left as written.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = Object.hasOwn(catalog, key) ? (catalog[key] ?? key) : key;
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}
