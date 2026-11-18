import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FixedClock } from '../../src/lib/clock.ts';
import { DESCRIPTIONS, FIELDS } from '../../src/mcp/descriptions.ts';
import { SERVER_INSTRUCTIONS, TOOL_NAMES } from '../../src/mcp/server.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { connectMcp } from '../helpers/mcp.ts';

/*
 * The tool descriptions are what an agent reads before it calls anything. These tests pin the
 * words that matter for personal spaces; the 1.0 substrings stay pinned by their own tests.
 */

test('whoami names usage, quota and whether links may be made', () => {
  const d = DESCRIPTIONS.whoami.description;
  expect(d).toMatch(/usage/i);
  expect(d).toMatch(/quota/i);
  expect(d).toMatch(/share links/i);
});

test('revoke_share_link states the 1.1 rule and the 1.0 one', () => {
  const d = DESCRIPTIONS.revoke_share_link.description;
  expect(d.startsWith('Only when the user asks to share')).toBe(true);
  expect(d).toMatch(/project's owner/);
  expect(d).toMatch(/editor/);
  expect(d).toMatch(/admin/);
});

test('the lists speak of what the account can see', () => {
  expect(DESCRIPTIONS.list_projects.description).toMatch(/shared with you/);
  expect(DESCRIPTIONS.list_projects.description).toMatch(/your role/);
  expect(DESCRIPTIONS.list_artifacts.description).toMatch(/you can see/);
});

test('create_share_link warns that an admin may have to approve the account', () => {
  expect(DESCRIPTIONS.create_share_link.description).toMatch(/approv/);
});

test('publishing without a target goes to your default project', () => {
  expect(DESCRIPTIONS.create_publish_session.description).toMatch(/your default project/);
});

test('the publish tools say that viewers cannot publish', () => {
  expect(DESCRIPTIONS.create_publish_session.description).toMatch(/viewers/i);
  expect(DESCRIPTIONS.publish_inline.description).toMatch(/viewers/i);
});

test('get_project reads your default project, and create_project makes one in your space', () => {
  expect(DESCRIPTIONS.get_project.description).toMatch(/your default project/);
  expect(DESCRIPTIONS.create_project.description).toMatch(/your space/);
});

test('the 1.0 substrings and placeholders stay', () => {
  expect(DESCRIPTIONS.get_project.description).toMatch(/before you publish/);
  expect(DESCRIPTIONS.create_publish_session.description).toContain('{{minutes}}');
  expect(DESCRIPTIONS.publish_inline.description).toContain('{{max}}');
  for (const name of ['create_share_link', 'list_share_links', 'revoke_share_link'] as const) {
    expect(DESCRIPTIONS[name].description.startsWith('Only when the user asks to share')).toBe(
      true,
    );
  }
});

test('resolve_comments takes the fixing version and resolves only what was addressed', () => {
  const d = DESCRIPTIONS.resolve_comments.description;
  expect(d.length).toBeLessThanOrEqual(350);
  expect(d).toContain('version_id');
  expect(d).toContain('Resolve only the threads you actually addressed');
});

test('every description is at most 350 characters', () => {
  for (const [name, d] of Object.entries(DESCRIPTIONS)) {
    expect(d.description.length, name).toBeLessThanOrEqual(350);
  }
});

test('edit_artifact points to the source on disk first', () => {
  const d = DESCRIPTIONS.edit_artifact.description;
  expect(d).toMatch(/on disk/);
  expect(d).toContain('create_publish_session');
});

test('the publish tools name replace_server_edits, to set only when the user asks', () => {
  for (const d of [
    DESCRIPTIONS.create_publish_session.description,
    DESCRIPTIONS.publish_inline.description,
    FIELDS.replaceServerEdits,
  ]) {
    expect(d).toContain('replace_server_edits');
    expect(d).toMatch(/only when the user asks/);
  }
});

test('read_file says that find matches within one line', () => {
  expect(DESCRIPTIONS.read_file.description).toMatch(/within one line/);
});

test('the server instructions name the tools that edit, download and resolve', () => {
  const steps = SERVER_INSTRUCTIONS.split('\n');
  expect(steps).toContain(
    '2. Publish: if you can run shell commands, call create_publish_session and run the command ' +
      'it returns; otherwise call publish_inline. To change an existing artifact without its ' +
      'source on disk, call edit_artifact; with a shell, create_download_session gets the files.',
  );
  expect(steps).toContain(
    '4. To address feedback: list_comments (each thread shows its source lines), fix the source ' +
      'or call edit_artifact, then resolve_comments with the new version_id.',
  );
});

/** The descriptions of a JSON schema's properties, at any depth. */
function propertyDescriptions(schema: unknown, into: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyDescriptions(item, into);
  } else if (typeof schema === 'object' && schema !== null) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'description' && typeof value === 'string') into.push(value);
      else propertyDescriptions(value, into);
    }
  }
  return into;
}

/** The names of every property in `schema`, at any depth. */
function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, into);
  } else if (typeof schema === 'object' && schema !== null) {
    const { properties } = schema as { properties?: unknown };
    if (typeof properties === 'object' && properties !== null) {
      for (const name of Object.keys(properties)) into.add(name);
    }
    for (const value of Object.values(schema)) propertyNames(value, into);
  }
  return into;
}

describe('what the tools are served with', () => {
  let ctx: TestContext;
  let client: Client;

  beforeAll(async () => {
    ctx = await createTestContext({ clock: new FixedClock(Date.UTC(2026, 10, 18)) });
    const ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
  });

  afterAll(async () => {
    await client?.close();
    await ctx?.close();
  });

  test('names only tools, their arguments and the one refusal code a description gives', async () => {
    const { tools } = await client.listTools();
    const known = new Set<string>([
      ...TOOL_NAMES,
      ...propertyNames(tools.map((tool) => tool.inputSchema)),
      'quota_exceeded',
    ]);
    const texts = [
      SERVER_INSTRUCTIONS,
      ...tools.flatMap((tool) => [
        tool.description ?? '',
        ...propertyDescriptions(tool.inputSchema),
      ]),
    ];
    const named = texts.flatMap((text) =>
      [...text.matchAll(/(?<![\w-])[a-z]+(?:_[a-z]+)+(?![\w-])/g)].map((m) => m[0]),
    );
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named.filter((name) => !known.has(name)))]).toEqual([]);
  });

  test('both publish tools describe replace_server_edits alike', async () => {
    const { tools } = await client.listTools();
    for (const name of ['create_publish_session', 'publish_inline']) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
        properties: Record<string, { description?: string }>;
      };
      expect(schema.properties.replace_server_edits?.description, name).toBe(
        FIELDS.replaceServerEdits,
      );
    }
  });
});
