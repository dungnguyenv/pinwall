# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting on the repository
[dungnguyenv/pinwall](https://github.com/dungnguyenv/pinwall/security/advisories/new): open the
**Security** tab and choose **Report a vulnerability**. Please do not open a public issue or a pull
request for it, and do not discuss it in public before a fix is out.

A report helps most when it says which version you ran, how Pinwall was set up (single-domain or
content-domain mode, `team` or `personal` visibility, SQLite or PostgreSQL, behind which proxy), and
the steps that show the problem.
A maintainer will acknowledge it, work on a fix with you in the private advisory, and credit you in
the release notes unless you would rather stay unnamed. Please give us a reasonable time to fix it
before you publish anything.

## Supported versions

The latest minor release of the current major version gets security fixes. When you are on an older
release, upgrade to the latest one; the changelog says what changed.

## How Pinwall is built to be safe

The short version, for deciding whether a report is a vulnerability. Pinwall's documents explain the
choices behind them: [README.md](README.md), [docs/install.md](docs/install.md#content-isolation),
[docs/open-instance.md](docs/open-instance.md) and [docs/configuration.md](docs/configuration.md).

- **Artifacts are untrusted.** A page an agent publishes can run any script. In single-domain mode
  every content response carries a `Content-Security-Policy: sandbox` header without
  `allow-same-origin`, so the page has an opaque origin and cannot read the app's cookies or act
  with its session. In content-domain mode every version is served from a host of its own on a
  separate domain, so the browser keeps the app and the pages apart by origin.
- **Capability tokens.** Content is reached through an unguessable token in the address, short-lived
  for a preview and longer-lived for a share link, and never by a cookie. The token is the only
  thing that grants access to content, and content responses never read or set a cookie. A share
  link's token is shown once and stored only as a hash.
- **CSRF.** A request that changes something and is authenticated by a cookie is accepted only when
  its `Origin` is the configured public origin, and, when the browser sends it, `Sec-Fetch-Site` is
  `same-origin`. Requests that carry a bearer token do not use cookies and are exempt.
- **Hashed secrets.** Session tokens, API tokens, OAuth tokens and share-link tokens are stored only
  as SHA-256 hashes, and passwords as salted scrypt hashes. The refresh tokens that Pinwall holds for
  single sign-on are encrypted with a key derived from `PINWALL_SECRET_KEY`. The values of the secret
  settings (the secret key, the database URL, the S3 keys and the OIDC client secret) can be read
  from files, and they never reach the log, the metrics, the admin page or a backup.
- **The app's own pages** carry a strict Content-Security-Policy, `X-Frame-Options: DENY`, and HSTS
  on https. Pinwall builds every absolute address from `PINWALL_PUBLIC_ORIGIN` and trusts forwarded
  headers only when `PINWALL_TRUST_PROXY` says so.
- **Private spaces.** With `PINWALL_VISIBILITY=personal`, a person sees only the projects they own
  or were added to, as a viewer or an editor. A request that names something in someone else's space
  by its id (a project, an artifact, a version, a comment or a share link) gets the answer that an
  id which does not exist would get, never a 403, on REST, MCP, search, live updates and raw links
  alike, so existence does not leak. A content token is not such an id but a capability: whoever
  holds one is served what it grants until it expires, and one made for a person who has since lost
  sight of the artifact answers 410, gone. Admins of the app count as someone else: they cannot read
  private work, and moderate through metadata and the look-up of reported addresses. The operator of
  the installation, who can read the database, can read everything, as with any self-hosted service.
  Moving a person's space to another account is a command on the server, `pinwall transfer`, and not
  a feature of the app, so that an admin cannot move a stranger's space into their own account to
  read it.
- **Who may expose content.** With `PINWALL_SHARE_LINKS=approved`, only admins and the people an
  admin approved can make share links, open raw links or have their pages open as a top-level page,
  and only for a version that an approved person or an admin published, or, in `personal` mode,
  one in a project whose owner is approved. Everything else is served only inside Pinwall's viewer,
  whoever opens it: a top-level load is refused, and responses name Pinwall as the only page that
  may frame them. The check runs each time a link or a content address is opened, and taking
  approval away revokes the person's links. It covers pages, not files: a content address that
  Pinwall handed to someone who is not approved still serves its files to an image, script or
  `fetch` on another site until it expires.
- **Moderation.** Admins can look up a reported share URL, artifact link or content URL, revoke
  links, end a version's open pages, delete a version or an artifact, and block the owner. Every
  such action is a structured log line, which is the audit trail.
- **Limits per account.** Rate rules, counted per account, limit publishing, content grants, share
  links, projects, member look-ups and comment writes. Each person runs at most 2 publishes at once,
  and the instance 4 besides admins' own. An upload that sends nothing for 60 seconds ends, and one
  publish runs for at most 10 minutes, or longer when `PINWALL_MAX_UPLOAD_BYTES` needs it at
  64 KiB/s, so a slow client cannot hold its place for long. Quotas, when an operator sets them, cap
  the bytes, artifacts and files one person stores, and an upload that does not fit stops while it
  streams. Comments, projects and the content grants Pinwall keeps are bounded by the rate rules
  only, and every limit counts accounts, so one person with many accounts at the identity provider
  gets the limits of each.
- **Access follows the identity provider.** Someone removed at the provider loses access by the next
  re-check (12 hours by default, 24 at most), and an admin can end a person's access with
  **Revoke now**: their next request is refused, and a live-update stream they have open ends
  within 25 seconds.
- **No telemetry.** Pinwall makes no request to any third party except the identity provider and the
  storage you configure.
- **The image** runs as a non-root user with a read-only root filesystem, and is built from a base
  image pinned by digest.

Things that are by design, and not vulnerabilities:

- Everyone who can open an artifact can read every file in it, so a secret that an agent publishes
  is visible until someone deletes it (and it stays in older backups).
- A single-domain installation is weaker than one with a separate content domain, as the README
  says.
- In `team` mode, the default, every member can open every artifact of the installation, as in
  Pinwall 1.0. Choose `personal` mode when people should not see each other's work.
- With SQLite, the order of a person's search results comes from FTS5 `bm25`, which ranks with
  statistics of the whole index. Text in other spaces can change the order of what someone finds,
  never which results they get, and only aggregate term frequency and document length leak.
  PostgreSQL ranking looks at one document at a time and does not depend on other documents.
- A content grant is kept for 30 days after it expires, so that an admin can still trace a reported
  content address to the person who made it.
- Adding a passkey, a password or an API token does not ask the person to sign in again, so whoever
  holds a signed-in session can add a lasting credential.
- An OAuth refresh token used a second time within 120 seconds gets a new pair instead of ending the
  grant, so agents that share a sign-in do not sign each other out. That also means that a stolen
  refresh token replayed within those 120 seconds goes unnoticed.

## Verifying a release

Every release image is signed with [cosign](https://github.com/sigstore/cosign) without a long-lived
key, by the release workflow of this repository, and carries build provenance and an SBOM of each
platform's image as attestations. Take the image's digest from the release notes, or from `docker buildx imagetools
inspect ghcr.io/dungnguyenv/pinwall:<version>`, and check that the release workflow signed it for
that version's tag:

```sh
cosign verify ghcr.io/dungnguyenv/pinwall@sha256:<digest> \
  --certificate-identity https://github.com/dungnguyenv/pinwall/.github/workflows/release.yml@refs/tags/v<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

To accept any release instead, as an admission policy might, match the identity against the release
tags of this repository:
`--certificate-identity-regexp '^https://github\.com/dungnguyenv/pinwall/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'`.

Check the build provenance with the GitHub CLI:

```sh
gh attestation verify oci://ghcr.io/dungnguyenv/pinwall@sha256:<digest> --repo dungnguyenv/pinwall
```

Use the digest, not the tag, in your deployment: a tag can be moved, a digest cannot. The Helm chart
is signed the same way and refers to the image by digest.
