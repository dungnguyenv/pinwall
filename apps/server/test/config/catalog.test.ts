import { readFileSync } from 'node:fs';
import { ConfigSection } from '@pinwall/shared';
import { describe, expect, test } from 'vitest';
import { describeConfig } from '../../src/api/admin-config.ts';
import {
  CONFIG_VARS,
  type ConfigVar,
  renderConfigurationDoc,
  SECTION_TITLES,
} from '../../src/config/catalog.ts';
import { loadConfig } from '../../src/config/load.ts';

const source = readFileSync(new URL('../../src/config/load.ts', import.meta.url), 'utf8');

const withData = (env: Record<string, string>) => ({ PINWALL_DATA_DIR: '/data', ...env });

describe('the catalog and the loader', () => {
  test('the catalog names exactly the variables the loader reads', () => {
    const read = new Set(
      [...source.matchAll(/'(PINWALL_[A-Z0-9_]+)'/g)]
        .map((m) => m[1] as string)
        .filter((name) => !name.endsWith('_FILE')),
    );
    expect(new Set(CONFIG_VARS.map((v) => v.name))).toEqual(read);
  });

  test('each variable is listed once', () => {
    const names = CONFIG_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('secret flags match the loader', () => {
    const secrets = new Set(
      [...source.matchAll(/\.secret\('(PINWALL_[A-Z0-9_]+)'\)/g)].map((m) => m[1] as string),
    );
    expect(new Set(CONFIG_VARS.filter((v) => v.secret).map((v) => v.name))).toEqual(secrets);
  });

  test('every default is the real default', () => {
    const base = loadConfig(withData({}));
    for (const v of CONFIG_VARS.filter((x) => x.default !== null)) {
      expect(loadConfig(withData({ [v.name]: v.default as string })), v.name).toEqual(base);
    }
  });

  test('a secret never has a default value to print', () => {
    for (const v of CONFIG_VARS.filter((x) => x.secret)) expect(v.default, v.name).toBeNull();
  });
});

describe('the catalog and the admin configuration page', () => {
  // PostgreSQL makes PINWALL_DATABASE_POOL_SIZE show a value, S3 the PINWALL_S3_* ones, and an
  // identity provider the PINWALL_OIDC_* ones, so nearly every default can be compared with what
  // the page shows. PINWALL_STORAGE is the exception: its default is `local`, which switches the
  // S3 settings off, so its default is compared with a configuration that keeps local storage.
  const defaults = describeConfig(loadConfig(withData({})));
  const full = describeConfig(
    loadConfig(
      withData({
        PINWALL_DATABASE_URL: 'postgres://pinwall@db.example/pinwall',
        PINWALL_SECRET_KEY: 'ab'.repeat(32),
        PINWALL_STORAGE: 's3',
        PINWALL_S3_BUCKET: 'b',
        PINWALL_OIDC_ISSUER: 'https://idp.example',
        PINWALL_OIDC_CLIENT_ID: 'c',
      }),
    ),
  );

  test('the page and the doc describe the same variables', () => {
    expect(new Set(full.entries.map((e) => e.env))).toEqual(
      new Set(CONFIG_VARS.map((v) => v.name)),
    );
  });

  test('each variable sits in the same section on the page and in the doc', () => {
    for (const v of CONFIG_VARS) {
      expect(full.entries.find((e) => e.env === v.name)?.section, v.name).toBe(v.section);
    }
  });

  test('the page shows each default the doc states', () => {
    // A secret is skipped: the page shows only whether it is set. PINWALL_DATABASE_URL is read
    // as a secret but shown with its password removed, and has no default to compare anyway.
    for (const v of CONFIG_VARS.filter((x) => x.default !== null && !x.secret)) {
      const page = v.name === 'PINWALL_STORAGE' ? defaults : full;
      expect(page.entries.find((e) => e.env === v.name)?.value, v.name).toBe(v.default);
    }
  });
});

describe('descriptions', () => {
  test('every variable has a short description', () => {
    for (const v of CONFIG_VARS) {
      expect(v.description.length, v.name).toBeGreaterThan(0);
      expect(v.description.length, v.name).toBeLessThanOrEqual(400);
    }
  });

  test('every section has a title and at least one variable', () => {
    for (const section of ConfigSection.options) {
      expect(SECTION_TITLES[section], section).toBeTruthy();
      expect(
        CONFIG_VARS.some((v) => v.section === section),
        section,
      ).toBe(true);
    }
  });

  test('nothing in a table cell can break the table', () => {
    for (const v of CONFIG_VARS) {
      for (const cell of [v.description, v.default ?? '', v.defaultNote ?? '']) {
        expect(cell, v.name).not.toMatch(/[|\n]/);
      }
    }
  });
});

describe('renderConfigurationDoc', () => {
  const sample: readonly ConfigVar[] = [
    {
      name: 'PINWALL_PORT',
      section: 'general',
      secret: false,
      default: '8080',
      description: 'Port to listen on.',
    },
    {
      name: 'PINWALL_SECRET_KEY',
      section: 'general',
      secret: true,
      default: null,
      defaultNote: 'generated into the data dir',
      description: 'The instance key.',
    },
    {
      name: 'PINWALL_S3_PREFIX',
      section: 'storage',
      secret: false,
      default: null,
      description: 'Key prefix.',
    },
    {
      name: 'PINWALL_MAX_FILES',
      section: 'limits',
      secret: false,
      default: '10000',
      description: 'Files per version.',
    },
  ];

  const doc = renderConfigurationDoc(sample);

  test('starts with a title and explains the two sources and the syntax', () => {
    expect(doc.startsWith('# Configuration\n')).toBe(true);
    expect(doc).toContain('environment variables');
    expect(doc).toContain('<NAME>_FILE');
    expect(doc).toContain('30s');
    expect(doc).toContain('KiB');
  });

  test('renders one table per section that has variables, in section order', () => {
    const headings = [...doc.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      SECTION_TITLES.general,
      SECTION_TITLES.storage,
      SECTION_TITLES.limits,
    ]);
    expect(doc.match(/^\| Variable \| Default \| Description \|$/gm)).toHaveLength(3);
  });

  test('writes defaults in code, notes as prose, and "none" when there is neither', () => {
    expect(doc).toContain('| `PINWALL_PORT` | `8080` | Port to listen on. |');
    expect(doc).toContain('| `PINWALL_S3_PREFIX` | none | Key prefix. |');
    expect(doc).toContain('generated into the data dir');
  });

  test('marks a secret and its _FILE form', () => {
    expect(doc).toContain('secret · also `PINWALL_SECRET_KEY_FILE`');
  });

  test('ends with the generated-file notice', () => {
    expect(
      doc.endsWith(
        'Generated from apps/server/src/config/catalog.ts by pnpm docs:config. Do not edit by hand.\n',
      ),
    ).toBe(true);
  });

  test('is deterministic', () => {
    expect(renderConfigurationDoc(sample)).toBe(doc);
  });
});

describe('docs/configuration.md', () => {
  test('is up to date', () => {
    expect(
      readFileSync(new URL('../../../../docs/configuration.md', import.meta.url), 'utf8'),
      'run pnpm docs:config',
    ).toBe(renderConfigurationDoc(CONFIG_VARS));
  });

  test('lists every variable in the catalog', () => {
    const doc = readFileSync(new URL('../../../../docs/configuration.md', import.meta.url), 'utf8');
    for (const v of CONFIG_VARS) expect(doc, v.name).toContain(`\`${v.name}\``);
  });
});
