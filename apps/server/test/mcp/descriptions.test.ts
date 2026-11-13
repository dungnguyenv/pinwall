import { expect, test } from 'vitest';
import { DESCRIPTIONS } from '../../src/mcp/descriptions.ts';

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

test('list and search speak of what the account can see', () => {
  expect(DESCRIPTIONS.list_projects.description).toMatch(/shared with you/);
  expect(DESCRIPTIONS.list_projects.description).toMatch(/your role/);
  expect(DESCRIPTIONS.list_artifacts.description).toMatch(/you can see/);
  expect(DESCRIPTIONS.search_artifacts.description).toMatch(/you can see/);
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
