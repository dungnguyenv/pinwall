import { screen, within } from '@testing-library/react';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { serveSidebar } from '../../test/library.ts';
import { renderRoute } from '../../test/render.tsx';
import { connectSnippets } from './snippets.ts';

// The skill is bundled at build time; each test picks whether it is there.
const bundled = vi.hoisted(() => ({ skill: null as string | null }));
vi.mock('./skill.ts', () => ({
  get skillText() {
    return bundled.skill;
  },
}));

const ORIGIN = 'http://localhost:3000';

beforeEach(() => {
  bundled.skill = null;
  serveSidebar();
});

test('snippets use this Pinwall address', () => {
  const s = connectSnippets('https://pinwall.example');
  expect(s.mcpUrl).toBe('https://pinwall.example/mcp');
  expect(s.claudeCode).toBe('claude mcp add --transport http pinwall https://pinwall.example/mcp');
  expect(JSON.parse(s.cursor)).toEqual({
    mcpServers: { pinwall: { url: 'https://pinwall.example/mcp' } },
  });
  expect(s.codex).toContain('[mcp_servers.pinwall]');
  expect(s.codex).toContain('url = "https://pinwall.example/mcp"');
});

test('the page shows each client with copyable snippets', async () => {
  const { user } = renderRoute('/connect');
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Connect an agent' }),
  ).toBeInTheDocument();
  expect(document.title).toBe('Connect an agent · Pinwall');

  const clients = screen.getByRole('tablist', { name: 'Agent' });
  expect(
    within(clients)
      .getAllByRole('tab')
      .map((tab) => tab.textContent),
  ).toEqual(['Claude Code', 'Cursor', 'Codex', 'Other']);

  // Claude Code is first: one command, run in a terminal.
  const claude = screen.getByRole('tabpanel', { name: 'Claude Code' });
  expect(within(claude).getByRole('textbox', { name: 'Run in a terminal' })).toHaveValue(
    `claude mcp add --transport http pinwall ${ORIGIN}/mcp`,
  );
  expect(within(claude).getByText('/mcp')).toBeInTheDocument();

  await user.click(within(clients).getByRole('tab', { name: 'Cursor' }));
  const cursor = screen.getByRole('tabpanel', { name: 'Cursor' });
  expect(within(cursor).getByText('~/.cursor/mcp.json')).toBeInTheDocument();
  const json = within(cursor).getByRole('textbox', { name: 'mcp.json' });
  expect(JSON.parse((json as HTMLTextAreaElement).value)).toEqual({
    mcpServers: { pinwall: { url: `${ORIGIN}/mcp` } },
  });

  await user.click(within(clients).getByRole('tab', { name: 'Codex' }));
  const codex = screen.getByRole('tabpanel', { name: 'Codex' });
  expect(within(codex).getByText('~/.codex/config.toml')).toBeInTheDocument();
  expect(within(codex).getByRole('textbox', { name: 'config.toml' })).toHaveValue(
    `[mcp_servers.pinwall]\nurl = "${ORIGIN}/mcp"`,
  );
  expect(within(codex).getByRole('textbox', { name: 'Then sign in' })).toHaveValue(
    'codex mcp login pinwall',
  );

  await user.click(within(clients).getByRole('tab', { name: 'Other' }));
  const other = screen.getByRole('tabpanel', { name: 'Other' });
  expect(within(other).getByRole('textbox', { name: 'MCP server address' })).toHaveValue(
    `${ORIGIN}/mcp`,
  );

  // Every snippet can be copied.
  expect(within(other).getByRole('button', { name: 'Copy' })).toBeInTheDocument();

  // Scripts and clients without OAuth use an API token.
  expect(screen.getByRole('link', { name: 'Create an API token' })).toHaveAttribute(
    'href',
    '/settings/tokens',
  );
});

test('the skill section appears only when the skill is bundled', async () => {
  renderRoute('/connect');
  await screen.findByRole('heading', { level: 1, name: 'Connect an agent' });
  expect(screen.queryByRole('button', { name: 'Download SKILL.md' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Pinwall skill for Claude Code' })).toBeNull();
});

test('the bundled skill downloads as SKILL.md with the command that installs it', async () => {
  bundled.skill = '---\nname: pinwall\n---\n# Pinwall\n';
  // jsdom has no object URLs: record the Blob and hand out a fixed URL.
  const blobs: Blob[] = [];
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    blobs.push(blob as Blob);
    return 'blob:http://localhost:3000/skill';
  };
  URL.revokeObjectURL = () => {};
  const clicked: { href: string; download: string }[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
  onTestFinished(() => {
    click.mockRestore();
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  });

  const { user } = renderRoute('/connect');
  const section = await screen.findByRole('region', { name: 'Pinwall skill for Claude Code' });
  await user.click(within(section).getByRole('button', { name: 'Download SKILL.md' }));

  expect(clicked).toEqual([{ href: 'blob:http://localhost:3000/skill', download: 'SKILL.md' }]);
  expect(await blobs[0]?.text()).toBe(bundled.skill);
  expect(
    within(section).getByRole('textbox', { name: 'Then move it into your skills folder' }),
  ).toHaveValue(
    'mkdir -p ~/.claude/skills/pinwall && mv ~/Downloads/SKILL.md ~/.claude/skills/pinwall/',
  );
});
