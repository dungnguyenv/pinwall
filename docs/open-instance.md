# Running an open instance

How to run Pinwall for people you do not know. Anyone your identity provider signs in gets a space of
their own, and nobody sees another person's work. This guide gives the settings to turn on, the order
to change an instance that already holds work, what the limits do, who may share pages outside
Pinwall, and what to do when someone reports abuse.

- [Settings](#settings)
- [Order of operations](#order-of-operations)
- [Quotas and rate limits](#quotas-and-rate-limits)
- [Who may share outside Pinwall](#who-may-share-outside-pinwall)
- [Handling an abuse report](#handling-an-abuse-report)
- [The moderation log](#the-moderation-log)
- [Moving work between people](#moving-work-between-people)
- [A separate content domain](#a-separate-content-domain)

In an open instance each person works in a space of their own: the projects they own, and the ones
an owner added them to. The owner of a project adds people with **Members** as viewers, who read and
comment, or as editors, who also publish, and the project shows up under **Shared with me** for
them. Admins manage people and answer reports, but they do not browse private work. The operator,
who can read the database, still can. Everything below describes `personal` mode unless it says
otherwise.

Adding someone to a project needs no consent from them. Any owner can put a project under anyone's
**Shared with me**, admins included, and add them again after they leave. A project's instructions
are text its owner wrote for agents to follow, so an agent connected to a stranger's project reads a
stranger's instructions. Treat such projects as you would any text from someone you do not know.

## Settings

A starting point for an instance that is open to the public. Each line is an environment variable:

```sh
PINWALL_VISIBILITY=personal
PINWALL_SHARE_LINKS=approved
PINWALL_QUOTA_BYTES=500MB
PINWALL_QUOTA_ARTIFACTS=200
PINWALL_QUOTA_FILES=50000
PINWALL_MAX_UPLOAD_BYTES=50MB
PINWALL_PREVIEW_TTL=2h
PINWALL_ABUSE_CONTACT=abuse@pinwall.example
# PINWALL_TERMS_URL=https://pinwall.example/terms
# PINWALL_PRIVACY_URL=https://pinwall.example/privacy
```

- `PINWALL_VISIBILITY=personal`: each person sees only the projects they own or were added to. The
  default, `team`, shows every project to every member, as Pinwall 1.0 did. A change takes a
  restart.
- `PINWALL_SHARE_LINKS=approved`: only admins and the people an admin approved may make share links,
  open raw links or open their pages outside Pinwall's viewer. The default, `members`, lets every
  member, as in 1.0.
- `PINWALL_QUOTA_BYTES=500MB`, `PINWALL_QUOTA_ARTIFACTS=200` and `PINWALL_QUOTA_FILES=50000`: the
  most one person may store, how many artifacts they may have, and how many files all their
  versions may hold together. All three default to `0`, which means no limit. The files quota is
  what stops versions of thousands of tiny files, which cost next to nothing in bytes, from filling
  the database.
- `PINWALL_MAX_UPLOAD_BYTES=50MB`: the largest publish request. The default is 95 MB. Pinwall reads
  a zip archive into memory whole before it unpacks it, and runs up to four publishes at once, so
  this limit decides what uploads can hold in memory: with 50 MB, four zips hold about 200 MB, and
  twice that for the moment each one is put together. It also sets how long one publish may run:
  about 13 minutes at 50 MB (see [Quotas and rate limits](#quotas-and-rate-limits)).
- `PINWALL_PREVIEW_TTL=2h`: how long a content address works once Pinwall has handed it out. The
  default is 12 hours.
- `PINWALL_ABUSE_CONTACT`: an email address or an http(s) URL where people report abuse. Pinwall
  shows it on share pages, on the pages for links that are gone or not found, and on the sign-in
  page.
- `PINWALL_TERMS_URL` and `PINWALL_PRIVACY_URL`, optional: links to your terms and your privacy
  notice, shown on the sign-in page.
- `PINWALL_TRUST_PROXY`, behind a reverse proxy or a tunnel: which proxies to believe about the
  visitor's address (see [configuration.md](configuration.md#general)). Without it every visitor
  has the proxy's address, so the limits Pinwall keeps per address, on opening share links, on
  password attempts and on guest comments, become one limit for everyone, which any stranger can
  use up.

The Helm chart takes them under `env:` (see the
[chart's example](../deploy/helm/pinwall/README.md#examples)), and Compose under `environment:`.
Each one is described in [configuration.md](configuration.md#spaces-and-sharing), and the quotas in
[Upload limits](configuration.md#upload-limits).

## Order of operations

On an instance that already holds work, change things in this order. An instance with nothing on it
can start with the final step already done.

1. **Personal mode, quotas and approval go first, while a member rule still holds.** Set the
   settings above, keep the member group, email or domain rule in place, and restart. Only the
   people you already admitted can sign in, so nobody new can see anything yet. Approve the people
   whose share links must keep working, and the people who published what those links show, before
   you restart (see [Who may share outside Pinwall](#who-may-share-outside-pinwall)).
2. **Move the existing work and check it.** Ownership follows the project, not whoever published
   into it: the migration to 1.1 gave every project an owner, and that may not be the person who
   should hold it. Move whole spaces with `pinwall transfer` (see
   [Moving work between people](#moving-work-between-people)). Then sign in with a second account
   and check that it sees none of it.
3. **Only then remove the member rule,** so that everyone the provider signs in becomes a member.
   [Open sign-up](sign-in.md#open-sign-up) shows how for Zitadel with Google, and for Google
   directly.

The order matters because removing the rule first would show everything. Until step 1 is done an
instance runs in `team` mode, where every member sees every project and can share it, so a stranger
who signs in would see it all.

## Quotas and rate limits

Quotas apply in both modes.

- **Who is limited.** Every person with a limit. Admins are exempt. An admin can set another limit
  for one person in **Admin, Users** (**Set limits…**), for storage and for artifacts, or go back to
  the instance's value. The limits an admin sets apply if that person stops being an admin. The
  files quota has no per-person value: it is the instance's for everyone but admins.
- **What counts.** The logical size of every version, from `versions.total_bytes`, each counted in
  full even when versions share files. In `personal` mode that is every version in the projects a
  person owns, including what editors publish there. A publish by an editor is checked against the
  owner's quota. In `team` mode it is what the person published, because projects are shared.
  Artifacts are counted the same way, and so are files: every file of every version, a restored
  version's included.
- **Freeing space.** Deleting old versions or artifacts frees it.
- **When it is checked.**
  - When a publish session or a web upload starts: a space that is already full is refused at once.
  - Before anything is stored: an inline publish or a restore that does not fit is refused, and so
    is an upload whose declared size (`Content-Length`) alone is larger than the bytes left. That
    size includes an archive's or a form's own bytes, so near the limit an upload can be refused
    even though its files alone would fit.
  - While an upload streams: it stops at the first bytes over what is left, or at the first file
    over the files left, and keeps nothing.
  - When the version is committed, with its real size, under a lock on the space, so two publishes
    cannot both take the last of it.
- **A refusal.** `quota_exceeded`, HTTP 413. It creates no version and leaves no files behind. Its
  message says how much is used and the limit, and how much the version needed when that is known;
  an upload stopped while it streams says it is larger than what is left. When the full space is
  not the publisher's, it says whose space is full: the project owner's. It suggests deleting old
  versions or asking an admin.
- **Where people see it.** In **Settings, Usage**, and in `whoami` for an agent, so that the agent
  can tell the person before it publishes.

The rate rules are fixed in code, count each person by account (across browsers, tokens and
addresses), and answer HTTP 429 `rate_limited` with the seconds to wait:

| What is counted | Limit |
| --- | --- |
| Publishing, by every route: upload sessions, inline publishes, web uploads and restoring a version | 60 per 10 minutes |
| Content grants: review, raw links and previews | 600 per hour |
| Share links created | 30 per hour |
| Projects created | 30 per hour |
| Adding a project member by email | 30 per hour |
| Comment writes: new threads, replies, edits, resolves and reopens, over REST and MCP | 60 per 10 minutes |

Pinwall keeps these counts in memory, so a restart clears them.

Some limits bound memory and time rather than a person. They hold for everyone, admins included,
except where they say otherwise:

- **Publishes in progress.** Each person may have 2 publishes running at once, and the instance 4,
  restores included. One more answers 429 `rate_limited` with `Retry-After: 10` before any of its
  files is read. Uploaded files go to storage as they arrive, never whole in memory. Admins are
  exempt from the instance's 4, so that you can still publish and restore while others hold every
  place, but each admin is still held to 2 at once.
- **How long a publish may run.** An upload whose body sends nothing for 60 seconds ends with 408
  `request_timeout`, through an upload URL or the web app alike. And one publish holds its place
  for at most 10 minutes, or for the time `PINWALL_MAX_UPLOAD_BYTES` takes at 64 KiB/s when that is
  longer: about 13 minutes at 50 MB, about 24 at the default 95 MB. Past that deadline it ends with
  408 `request_timeout`, keeps nothing and gives its place back, however steadily its client is
  still sending. The deadline holds in both modes, so an upload of the largest size that averages
  under 64 KiB/s (about half a megabit a second) fails.
- **What these limits leave open.** Several accounts can keep the instance's 4 places busy, cycle
  after cycle: each upload holds its place until the deadline, and then they start again. Blocking
  an account does not stop the uploads it is already running. Everyone else, admins aside, gets 429
  `server_busy` meanwhile, which `pinwall_uploads_rejected_total{reason="server_busy"}` shows. The
  response is to block the accounts: their places come back within the deadline.
- **Zip archives** are the exception: Pinwall reads a zip whole into memory before it unpacks it,
  up to `PINWALL_MAX_UPLOAD_BYTES`. Hence the 50 MB in [Settings](#settings). A tar or tar.gz
  streams.
- **Review pages.** To let people comment on text and elements, Pinwall adds its annotator to an
  HTML page shown for review, which means holding the page in memory while it is sent. It does so
  only for pages of up to 5 MB, and holds at most 50 MB of them at once across all requests. A
  larger page, or one asked for while those 50 MB are taken, is served as it is stored, without the
  annotator, and takes point comments only (see
  [Writing pages](authoring.md#the-pages-own-content-security-policy)).

What the quotas do not count: comments, projects, and the content grants Pinwall keeps for 30 days.
The rate rules alone bound them. Nothing bounds how many accounts one person makes at your identity
provider, and each account gets every limit above.

## Who may share outside Pinwall

A page that Pinwall hands out under your domain is attractive to someone who wants a link on a
domain with a good name. With `PINWALL_SHARE_LINKS=approved`, a person who is not approved cannot:

- create share links. The share dialog says why, and MCP and the REST API refuse with a message that
  an admin has to allow it. Links they made before still list and can be revoked;
- open raw links, which serve an artifact's files as they are;
- have their pages open as a top-level page. Their review pages work inside Pinwall's viewer, full
  screen included: a top-level load is refused, and every response says that only Pinwall's own
  pages may frame it.

**Who published a version counts too, not only who opens it.** A version opens outside the viewer
only when the person who published it is approved or an admin, or, in `personal` mode, when the
owner of its project is. Until then it stays inside the viewer whoever opens it, admins included:
nobody can make a share link to it, open its raw page or load it as a top-level page, and the share
dialog says why. So adding an approved person to a stranger's project exposes nothing, and an
approved owner can still share what an editor published in their own project.

**A restore makes the person who restores the publisher.** Restoring an old version copies it into
a new version, published by whoever restored it. When an approved person restores a version that a
stranger published, the copy can be shared and opened outside Pinwall. Only that person's own
action does it, so restore only pages you have checked.

An admin approves a person with the **may expose content** switch in **Admin, Users**. Admins never
need it.

**With `approved`, the nested frames of an unapproved person's pages do not load in the viewer.**
A page that embeds other pages of its own version in frames loads, and each frame shows the
browser's error page. The viewer's sandbox gives the page an origin that never matches the policy
those pages are served with, so the browser refuses to frame them. It happens in single-domain and
in content-domain mode alike, and approval lifts it. See
[Writing pages](authoring.md#links-frames-and-anchors).

**Approve people before switching.** The check runs every time a link is opened, not only when it is
made: a link opens only while its maker may expose content and the version it shows was published
by someone who may (or, in `personal` mode, sits in a project whose owner may). So switching an
existing instance to `approved` stops the links of everyone who is not approved yet, and the links
to versions that people who are not approved published. Approve the people who publish, not only
those who make links. A stopped link is suspended, not revoked, and answers as a revoked link
does: it opens again as soon as those people are approved.

- **Removing approval** revokes that person's share links for good, the same way losing access does.
- **Links handed over by a transfer** open only if the person who receives them is approved.
- **Content addresses** (`/c/<token>/…`, or `<token>.<content host>` with a content domain) are
  capability URLs: whoever holds one can open the page until it expires, after `PINWALL_PREVIEW_TTL`,
  12 hours by default. Setting `2h` shortens how long a leaked one keeps working. One that a share
  link handed out keeps working until then even when the link is suspended because of its maker
  (not approved yet, or no longer admitted by the identity provider); the link itself stops at
  once.
- **Only pages are held inside the viewer, not files.** For a person who is not approved, Pinwall
  refuses a top-level load and a frame on another site, but the content addresses it hands that
  person still serve their files to an `<img>`, a `<script>`, a stylesheet or a `fetch` on any site
  until they expire. Browsers do not tell such loads apart from the page's own. Keep
  `PINWALL_PREVIEW_TTL` short, and treat a report of hotlinked files like any other.

Approval changes nothing while `PINWALL_SHARE_LINKS` is `members`.

## Handling an abuse report

A report arrives with an address, usually a share link or a content address. Pinwall tells you whose
it is without showing you the page.

1. Open **Admin, Look up a link** and paste the address. It takes a share URL, an `/a/…` link, or a
   content URL (`/c/<token>/…`, or `<token>.<content host>/…`). Anything that is not an http(s)
   address is refused, and an address that belongs to nothing here answers 404.
2. Read the answer: the artifact and its project, its owner, the version and who published it, and
   the link or the grant the address belongs to.
3. Act on it:
   - revoke the share link;
   - end the version's open pages (its content grants). A link that follows the version makes new
     ones when it is opened again, so revoke that link as well;
   - delete the version, or the artifact;
   - block the owner, which also revokes every link they made;
   - or, in `personal` mode, **Delete all content** under **Admin, Users**, which removes everything
     the person owns and needs their email typed to confirm. Their account stays, and you see none
     of what is deleted.

**Who made a content address, once it has expired.** Pinwall keeps an expired content grant for 30
days, so a report that arrives late can still be traced to the owner. For someone who sits at the
limit of 600 grants an hour, that is up to 600 × 24 × 30 = 432,000 rows. On PostgreSQL a row takes
about 270 bytes with the table's five indexes (measured on 432,000 rows: 63 MB of table, 53 MB of
indexes), so about 120 MB for that one person. After 30 days the look-up answers 404. Content that
was revoked or deleted answers 410 and cannot be attributed.

**Where the abuse contact does not show.** A share link without comments sends the visitor straight
to the raw page, which is the artifact's files as they are, so it carries no abuse contact. With
`PINWALL_SHARE_LINKS=approved` only approved people can make such links. The contact shows on the
viewer of a link that allows comments, on the password page of a locked link, and on the pages of
links that are gone or not found.

Admins never open private content. The **Share links** page, which lists every link that is not
revoked or expired, has no "open", because Pinwall stores only a hash of each token and cannot
rebuild the address. The operator, who can read the database, can open anything.

## The moderation log

The log is the audit trail, because 1.1 has no audit table. Every admin action is one JSON line with
the message `moderation`:

```json
{"level":"info","time":"…","admin_id":"usr_…","action":"share_link.revoke","target":{"share_link_id":"…"},"outcome":"done","msg":"moderation"}
```

- `admin_id` is who did it, `action` what, and `target` the ids and the change asked for, never a
  token or an address.
- `outcome` is `done`, `refused` or `failed`. A done line carries `result` when the action has one
  (how many links or grants it ended, say). A refused line carries the `status` and `code` of the
  answer.
- The actions are `user.update` (approval and quota changes), `user.purge`, `share_link.revoke`,
  `lookup`, `artifact.delete`, `version.delete` and `version.end_grants`. A `lookup` line names the
  kind of address and the artifact, not the address.
- A person who deletes their own content under **Settings, Usage** (**Delete all my content**)
  leaves a `self.purge` line with `user_id`. Pinwall writes it before the deletion runs, so it has
  no `outcome`: a deletion that failed leaves the same line as one that worked.
- `pinwall transfer` writes a `transfer` line. The command logs to its own output, in the terminal
  of whoever runs it, and not to the server's log, so keep what it prints.
- Pinwall 1.0 already logs `role override changed` when an admin sets or clears a role or blocks
  someone, and `credentials revoked` for **Revoke now**.

Read the lines with `docker logs pinwall` or `kubectl logs deploy/pinwall`. Keep the logs as long as
reports may arrive.

## Moving work between people

`pinwall transfer` moves every project one person owns to another, in one transaction. Run it where
the server runs, with `docker exec` or `kubectl exec`:

```sh
docker exec pinwall pinwall transfer --from <id|email> --to <id|email>
kubectl exec deploy/pinwall -- pinwall transfer --from <id|email> --to <id|email>
```

Name each person by email or by id (`usr_…`). An email that several accounts share is refused, with
their ids listed and nothing moved, so run the command again with ids.

- When both people have a default project, the source's becomes an ordinary project named "Default
  (from <name>)".
- Members stay members. The target's own membership in a moved project goes, because the target now
  owns it.
- In `personal` mode the previous owner's open pages, live updates and unused upload URLs for the
  moved projects end.
- Share links are handed over to the target and keep opening, as long as the target may use them:
  with `approved`, that means only while the target is approved.
- Quotas are not checked. The usage moves with the projects, so the target may end up over their
  limit until they delete something.
- A transfer that races the target's first default project fails and moves nothing. Run it again.

Going back from `personal` to `team` is refused at startup when more than one person owns a project,
because every member would then see all of their projects. The message reads:

> PINWALL_VISIBILITY is team, but Pinwall last ran in personal mode and 3 people own projects. In
> team mode every member would see all of their projects. To allow that, run pinwall visibility team
> --confirm once and start Pinwall again, or set PINWALL_VISIBILITY=personal.

Run `pinwall visibility team --confirm` while the instance still runs in `personal` mode, right
before the restart that changes the setting.

There is no transfer in the app, by design. An admin who could move a stranger's space into their own
account could read it there and move it back, and the promise that admins do not read private work
would mean nothing.

## A separate content domain

By default Pinwall serves an artifact from the app's own host, inside a sandbox. On an open instance
that page is a stranger's HTML, and it sits on the domain your sign-in page lives on. That puts the
app, and its people, at risk:

- a phishing page can get the domain onto blocklists, and the app goes down with it;
- a link on your domain borrows your domain's good name, which is what makes it worth abusing;
- a content domain that shares the app's registrable domain, a subdomain of it for example, also
  shares its cookie scope. Pinwall logs a warning when you set one up like that.

A content domain holds nothing but artifacts, on a domain of its own. If it is blocklisted, the app
stays up and its reputation stays clean. See [Content isolation](install.md#content-isolation) for
how to set one up.

A content domain does not change who may open what. In particular it does not lift the limit that
[a person who is not approved](#who-may-share-outside-pinwall) has: the nested frames of their pages
do not load in the viewer in either mode.

Prefer PostgreSQL for an open instance. With SQLite, search results are ranked using statistics of
the whole index, so other people's text can change the order of what a person finds, though never
which results they get. [SECURITY.md](../SECURITY.md#how-pinwall-is-built-to-be-safe) says what that
leaks. [Moving to Postgres and S3](backup.md#moving-from-sqlite-and-local-disk-to-postgres-and-s3)
shows the way over.
