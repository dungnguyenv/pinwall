import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PublishResult } from '@pinwall/shared';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { FixedClock } from '../../src/lib/clock.ts';
import type { ErrorCode } from '../../src/lib/errors.ts';
import { TOOL_NAMES } from '../../src/mcp/server.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { connectMcp, propertyNames } from '../helpers/mcp.ts';

/*
 * The Agent Skill names tools, their arguments, the fields of the JSON the upload command prints,
 * and error codes. These tests keep it in step with what `/mcp` actually serves, so a renamed
 * field breaks the build rather than an agent.
 */

const skill = readFileSync(new URL('../../../../skills/pinwall/SKILL.md', import.meta.url), 'utf8');

/** Every M1 error code; the `Record` makes the compiler flag a code added to or removed from `ErrorCode`. */
const ERROR_CODES = Object.keys({
  bad_request: true,
  unauthorized: true,
  forbidden: true,
  not_found: true,
  method_not_allowed: true,
  conflict: true,
  version_conflict: true,
  gone: true,
  request_timeout: true,
  payload_too_large: true,
  unsupported_media_type: true,
  rate_limited: true,
  upload_session_used: true,
  upload_session_expired: true,
  setup_required: true,
  setup_done: true,
  invalid_credentials: true,
  access_denied: true,
  quota_exceeded: true,
  internal: true,
} satisfies Record<ErrorCode, true>);

/** The `details.reason` values the skill names for a `forbidden` refusal. */
const FORBIDDEN_REASONS = ['share_links_not_approved'];

/** The `details.reason` values the skill names for a `conflict` refusal. */
const CONFLICT_REASONS = ['edited_on_server'];

/** The `key: value` lines between the first two `---` lines. */
function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(0);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(': ');
    expect(colon, `frontmatter line "${line}"`).toBeGreaterThan(0);
    fields[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return fields;
}

let ctx: TestContext;
let client: Client;

beforeAll(async () => {
  ctx = await createTestContext({ clock: new FixedClock(Date.UTC(2026, 10, 10)) });
  const ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
  client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
});

afterAll(async () => {
  await client?.close();
  await ctx?.close();
});

test('frontmatter names the skill and says when to use it', () => {
  const fm = parseFrontmatter(skill);
  expect(Object.keys(fm).sort()).toEqual(['description', 'name']);
  expect(fm.name).toBe('pinwall');
  const description = fm.description ?? '';
  expect(description.length).toBeGreaterThan(80);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(description).toMatch(/Pinwall/);
  expect(description).toMatch(/Use when/);
  expect(skill.split('\n').length).toBeLessThanOrEqual(160);
});

test('the skill names every tool and nothing that does not exist', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) expect(skill).toContain(`\`${name}\``);

  const known = new Set<string>([
    ...TOOL_NAMES,
    ...propertyNames(tools.map((tool) => tool.inputSchema)),
    // The upload command prints a publish result as JSON.
    ...Object.keys(PublishResult.shape),
    ...ERROR_CODES,
    ...FORBIDDEN_REASONS,
    ...CONFLICT_REASONS,
  ]);
  const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
  expect(named.filter((name) => name !== undefined && !known.has(name))).toEqual([]);
});

test('the skill handles the space refusals', () => {
  for (const s of ['quota_exceeded', 'share_links_not_approved', 'shared with you', 'viewer'])
    expect(skill, s).toContain(s);
  expect(skill).toMatch(/do not retry/i);
});

test('the skill is at most 5,000 bytes', () => {
  expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(5000);
});

test('the skill says how to edit, and what to do when the server refuses a stale base', () => {
  for (const s of [
    '`create_download_session`',
    '`read_file`',
    '`edit_artifact`',
    '`version_conflict`',
    '`edited_on_server`',
    '`replace_server_edits`',
  ])
    expect(skill, s).toContain(s);
  expect(skill).toMatch(/diff/);
  // Ruling R24: a merged copy goes through with the flag; without a merge, only the user decides.
  const prose = skill.replace(/\s+/g, ' ');
  expect(prose).toContain('publish again with `replace_server_edits` set to true');
  expect(prose).toContain('only if the user asks');
  // A conflict the upload command prints is the REST error, without the diff.
  expect(prose).toMatch(/one from the upload command does not: call `get_artifact`/);
  // get_project gives what publishing needs, so no call to whoami comes first.
  expect(skill).not.toMatch(/once per session/);
});
