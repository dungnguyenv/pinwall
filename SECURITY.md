# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting on the repository
[dungnguyenv/pinwall](https://github.com/dungnguyenv/pinwall/security/advisories/new): open the
**Security** tab and choose **Report a vulnerability**. Please do not open a public issue or a pull
request for it, and do not discuss it in public before a fix is out.

A report helps most when it says which version you ran, how Pinwall was set up (single-domain or
content-domain mode, SQLite or PostgreSQL, behind which proxy), and the steps that show the problem.
A maintainer will acknowledge it, work on a fix with you in the private advisory, and credit you in
the release notes unless you would rather stay unnamed. Please give us a reasonable time to fix it
before you publish anything.

## Supported versions

The latest minor release of the current major version gets security fixes. When you are on an older
release, upgrade to the latest one; the changelog says what changed.

## How Pinwall is built to be safe

The short version, for deciding whether a report is a vulnerability. Pinwall's documents explain the
choices behind them: [README.md](README.md) and [docs/configuration.md](docs/configuration.md).

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
- **Access follows the identity provider.** Someone removed at the provider loses access by the next
  re-check (12 hours by default, 24 at most), and an admin can end a person's access at once.
- **No telemetry.** Pinwall makes no request to any third party except the identity provider and the
  storage you configure.
- **The image** runs as a non-root user with a read-only root filesystem, and is built from a base
  image pinned by digest.

Things that are by design, and not vulnerabilities: everyone who can open an artifact can read every
file in it, so a secret that an agent publishes is visible until someone deletes it (and it stays in
older backups); a single-domain installation is weaker than one with a separate content domain, as
the README says; and every member can open every artifact of the installation, because Pinwall has no
per-project permissions.

## Verifying a release

Every release image is signed with [cosign](https://github.com/sigstore/cosign) without a long-lived
key, by the release workflow of this repository, and carries build provenance and an SBOM as
attestations. Take the image's digest from the release notes, or from `docker buildx imagetools
inspect ghcr.io/dungnguyenv/pinwall:<version>`, and check the signature:

```sh
cosign verify ghcr.io/dungnguyenv/pinwall@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/dungnguyenv/pinwall/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Check the build provenance with the GitHub CLI:

```sh
gh attestation verify oci://ghcr.io/dungnguyenv/pinwall@sha256:<digest> --repo dungnguyenv/pinwall
```

Use the digest, not the tag, in your deployment: a tag can be moved, a digest cannot. The Helm chart
is signed the same way and refers to the image by digest.
