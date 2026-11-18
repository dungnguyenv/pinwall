# Connect an agent to Pinwall

Pinwall runs an MCP server at `/mcp` on its public address. An agent connected to it can publish
pages and sites, hand you review links, read the comments people pin on them and resolve them once
fixed. There is nothing to install and no token to copy: Pinwall is the OAuth server for its own
MCP endpoint. The first time, your agent opens a browser, you sign in to Pinwall (with the owner
account or your identity provider) and approve the agent.

The examples use `https://pinwall.example` as the Pinwall address. Use your own, which is the
`PINWALL_PUBLIC_ORIGIN` your Pinwall runs with. The **Connect an agent** page in Pinwall (in the
account menu, at `/connect`) shows the same snippets with your address already filled in.

An agent sees what you see. On a Pinwall with personal spaces, that is the projects you own and the
ones other people shared with you, each with your role in it, and an agent publishes into a shared
project only when you are an editor there. A publish that names no project goes into your default
project. On other Pinwalls it sees every project. [Spaces, projects and members](spaces.md)
explains the roles.

## Claude Code

Run in a terminal:

```sh
claude mcp add --transport http pinwall https://pinwall.example/mcp
```

This adds Pinwall to the project you run it in. Add `--scope user` to the command to have Pinwall
in every project.

Then sign in: in Claude Code, type `/mcp`, select **pinwall** and authenticate. Claude Code opens
your browser on Pinwall's sign-in and approval page. You can also sign in from a terminal with
`claude mcp login pinwall`; where no browser can open (over SSH, for example), it prints the
address to open on your own machine and asks you to paste back the address your browser ends on.

## Cursor

Add Pinwall to `~/.cursor/mcp.json` to have it in every project, or to `.cursor/mcp.json` in one
project:

```json
{
  "mcpServers": {
    "pinwall": {
      "url": "https://pinwall.example/mcp"
    }
  }
}
```

If the file already lists servers, add the `pinwall` entry next to them inside `mcpServers`.

Cursor finds out from Pinwall that the server needs sign-in. When it asks you to log in to
pinwall (servers are listed under **Customize** in Cursor's sidebar), sign in to Pinwall in the
browser it opens and approve Cursor.

## Codex

Add Pinwall to `~/.codex/config.toml`:

```toml
[mcp_servers.pinwall]
url = "https://pinwall.example/mcp"
```

Then sign in from a terminal:

```sh
codex mcp login pinwall
```

Codex opens your browser for the sign-in. Without a local browser, add `--no-browser`: Codex prints
the address to open, and you paste back the address your browser ends on. In the Codex desktop
app and IDE extension you can choose **Authenticate** instead.

## Other clients

Any MCP client that speaks Streamable HTTP connects to:

```text
https://pinwall.example/mcp
```

A client that supports MCP authorization finds Pinwall's OAuth endpoints on its own: it registers
itself, signs you in through your browser with PKCE, and renews its access as it goes.

A client without OAuth, or a script, uses a Pinwall API token instead. Create one in Pinwall under
**Settings → API tokens** (one token per client, so you can revoke each on its own), and have the
client send it on every request as:

```text
Authorization: Bearer pw_…
```

The clients above take a token too, when OAuth is not an option for you. With the token in the
environment variable `PINWALL_TOKEN`:

- Claude Code: `claude mcp add --transport http pinwall https://pinwall.example/mcp --header "Authorization: Bearer $PINWALL_TOKEN"`.
  Your shell fills in the token, and Claude Code keeps it in its configuration.
- Cursor: add `"headers": { "Authorization": "Bearer ${env:PINWALL_TOKEN}" }` next to `url`.
  Cursor reads the variable itself, so the token stays out of `mcp.json`.
- Codex: add `bearer_token_env_var = "PINWALL_TOKEN"` under `[mcp_servers.pinwall]`. Codex reads
  the variable itself, so the token stays out of `config.toml`.

## Installing the skill

The Pinwall skill teaches Claude Code the review loop: publish, give you the review link, then
read the comments and fix what they ask. It works best together with the connection above.

Copy `skills/pinwall/SKILL.md` from Pinwall's repository to `~/.claude/skills/pinwall/SKILL.md`
(every project), or to `.claude/skills/pinwall/SKILL.md` inside one project. Or download it with
**Download SKILL.md** on the Connect page and move it into place:

```sh
mkdir -p ~/.claude/skills/pinwall && mv ~/Downloads/SKILL.md ~/.claude/skills/pinwall/
```

Install it again after you upgrade Pinwall. The skill names the tools of its own version, and an
old copy can name tools that are gone: 1.2 merged `search_artifacts` into `list_artifacts` and
renamed `resolve_comment` to `resolve_comments`.

## The tools

An agent reads the list of tools, with a short description of each, when it connects.

| Tool | What it does |
| --- | --- |
| `whoami` | The account and its role, this Pinwall's limits and, where they apply, your usage and quota |
| `list_projects` | The projects you can see, with your role in each |
| `get_project` | One project's instructions for agents, the authoring notes and the inline limit |
| `create_project` | Makes a project |
| `list_artifacts` | Artifacts, newest first, by project or tag, or the best matches for `query` |
| `get_artifact` | One artifact's links, newest versions and current files |
| `read_file` | One file of a version, with line numbers: a range, or the lines that contain some text |
| `create_download_session` | A one-time shell command that downloads a version into a folder |
| `edit_artifact` | Replaces text in, writes or deletes files on the server, as a new version |
| `create_publish_session` | A one-time upload URL and the shell command that publishes a folder or a file to it |
| `publish_inline` | Publishes text files passed in the call, for agents without a shell |
| `list_comments` | Comment threads, with where each one sits in the source |
| `reply_to_comment` | Replies to a thread |
| `resolve_comments` | Resolves up to 50 threads in one call, each with an optional reply |
| `create_share_link` | A link for people without an account, made only when you ask |
| `list_share_links` | An artifact's share links, without their URLs |
| `revoke_share_link` | Ends a share link |

An agent with the page's files on disk edits them there and publishes them, and one with a shell
can get them with `create_download_session`. Otherwise, as in Claude Desktop, it reads and changes
the artifact on the server with `read_file` and `edit_artifact`. When an artifact was edited on the
server since its last full publish, a publish of an older copy is refused so that the edit is not
lost. The agent then brings those changes into its copy and publishes again; it publishes over them
without merging only when you ask.

`read_file`, `create_download_session` and `list_comments` share a limit of 600 calls an hour per
person.

## Troubleshooting

**Sign-in fails or the agent cannot connect.** The address must be your `PINWALL_PUBLIC_ORIGIN`
followed by `/mcp`, as in `https://pinwall.example/mcp`. Pinwall signs agents in only for that
exact address, so an internal hostname, an IP address, another port, or `http://` in place of
`https://` makes the sign-in fail, even when it reaches the same server.

**"This app is not registered with this Pinwall".** Pinwall forgets an agent's registration after
30 days without use, and a reset data directory forgets all of them. Remove the server from your
agent and add it again, then sign in. In Claude Code:

```sh
claude mcp remove pinwall
claude mcp add --transport http pinwall https://pinwall.example/mcp
```

In Cursor and Codex, remove the `pinwall` entry and add it back, then sign in again
(`codex mcp login pinwall` for Codex).

**The agent was signed out.** After an admin uses **Revoke now** on your account, every agent
connection you had stops working at once. Sign in again from the agent: `/mcp` in Claude Code,
`codex mcp login pinwall` for Codex, Cursor's login prompt. Revoke now ends API tokens as well,
so a client that used one needs a new token. If your access to Pinwall itself was removed, the
sign-in page says so and shows which account you signed in with.

**The agent says `quota_exceeded`.** Your space is full, and nothing was published. It holds as
much as it may, in bytes, in artifacts or in files, and for a project that someone else owns, it is
the owner's space that counts. Look at **Settings → Usage**, delete versions or artifacts you no
longer need, or ask an admin for more room. The agent should not retry until then. It can read the
numbers with `whoami`. See [Usage and limits](spaces.md#usage-and-limits).

**The agent cannot publish into a project.** You are a viewer there, which lets you read and
comment but not publish. Pinwall's answer says to ask the project's owner to make you an editor,
which they do in **Members**. Meanwhile the agent can publish into a project of your own. See
[Project members](spaces.md#project-members).

**The agent cannot make a share link.** There are three causes. A viewer cannot make links in a
project, so the owner has to make you an editor, as above. On a Pinwall where an admin has to
approve who may share outside Pinwall, Pinwall's answer says that an admin has to allow it for your
account, and an admin does that in **Admin → Users**. On such a Pinwall the version counts too: it
can be shared only when the person who published it is approved, or, with personal spaces, the
owner of its project is. Otherwise Pinwall refuses the link (`version_not_exposable`) even for an
approved account, and the publisher or the owner has to be approved first. People who have an
account can still open the review link. See
[Sharing outside Pinwall](spaces.md#sharing-outside-pinwall).

**A web page cannot call `/mcp`.** Pinwall refuses requests to `/mcp` that come from a page in a
browser tab, whether a published artifact or another site, and `/mcp` never reads browser
cookies. Connect through an MCP client, or call the REST API with an API token from a script.
