import messages from '@pinwall/shared/i18n/en.json' with { type: 'json' };

const catalog: Readonly<Record<string, string>> = messages;

/** English plural categories: `one` for 1, `other` for every other number. */
const plurals = new Intl.PluralRules('en');

/**
 * The key a string is stored under: with a number `count`, its plural form (`key_one`,
 * `key_other`) when the catalog has one, as i18next picks it in the web app; else `key`.
 */
function keyFor(key: string, vars: Record<string, string | number> | undefined): string {
  const count = vars?.count;
  if (typeof count !== 'number') return key;
  const plural = `${key}_${plurals.select(count)}`;
  return Object.hasOwn(catalog, plural) ? plural : key;
}

/**
 * Looks up an English UI string and fills `{{name}}` placeholders from `vars`, in the plural
 * form `vars.count` calls for when the string has plural forms.
 * A missing key returns the key itself; a placeholder without a value is left as written.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const found = keyFor(key, vars);
  const template = Object.hasOwn(catalog, found) ? (catalog[found] ?? key) : key;
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}
