# Configuration

Pinwall reads its infrastructure settings from environment variables, and from nothing else. The admin page under **Configuration** shows what the server runs with; it never changes anything, so edit your deployment and restart.

A variable marked **secret** can also be given as `<NAME>_FILE`, the path of a file that holds the value, which is how container and Kubernetes secrets are usually mounted. Set `<NAME>` or `<NAME>_FILE`, not both: Pinwall refuses to start when both are set. Pinwall never shows a secret's value on the admin page, and never writes it to its logs or to a backup.

Values are written like this:

- **Durations** are a whole or decimal number with an optional unit: `ms`, `s`, `m`, `h` or `d`. A bare number is milliseconds. Examples: `500`, `30s`, `15m`, `12h`, `7d`.
- **Sizes** are a number with an optional unit: `B`, the decimal `KB`, `MB` and `GB`, or the binary `KiB`, `MiB` and `GiB`. A bare number is bytes. Examples: `95000000`, `95MB`, `2GiB`.
- **Numbers** that are not sizes or durations (ports, counts, the pool size, the expansion ratio) are whole numbers.
- **Lists** are separated by commas or spaces.
- **Booleans** are `true` or `false`.
- A variable that is empty or only blank counts as not set.

## General

Where Pinwall listens, what address it presents to the world, and where it keeps its files.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_PUBLIC_ORIGIN` | `http://localhost:8080` | The address people use to reach Pinwall: scheme, host and optional port, with no path. Every link, redirect, passkey and cookie setting is built from it, and an https origin turns on secure cookies and HSTS. Set it to your real address. |
| `PINWALL_HOST` | `0.0.0.0` | The network address the app listens on. `0.0.0.0` means every interface. |
| `PINWALL_PORT` | `8080` | The port the app listens on, from 0 to 65535 (0 lets the system pick a free one). The metrics listener must use a different port, see `PINWALL_METRICS_PORT`. |
| `PINWALL_DATA_DIR` | `/data` | The folder for what Pinwall keeps on disk: the SQLite database, locally stored files, the generated secret key and temporary files such as backup spools. It must be writable, and persistent when you use SQLite or local storage. |
| `PINWALL_SECRET_KEY`<br>secret · also `PINWALL_SECRET_KEY_FILE` | generated into `<data dir>/secret.key` (SQLite only) | The key that Pinwall derives its encryption and signing keys from: 64 hex characters or base64 that decodes to at least 32 bytes (`openssl rand -hex 32` makes one). Required with PostgreSQL. Keep it with your backups, because what it encrypts cannot be read without it. |
| `PINWALL_TRUST_PROXY` | `false` | Which reverse proxies to believe about the visitor address. `false` trusts none and ignores `X-Forwarded-For`. `true` trusts exactly one proxy. A comma-separated list of IP addresses or CIDR ranges trusts those proxies, for two or more in a row. Without a match, every visitor has the proxy's address and shares its limits per address: rate limits, and 20 open live-update streams. |
| `PINWALL_METRICS_PORT` | `9464` | The port of the separate listener that serves Prometheus metrics at `/metrics`; the app port never serves them. 0 turns metrics off. It must differ from `PINWALL_PORT`. Keep this port off the public network. |
| `PINWALL_LOG_LEVEL` | `info` | How much the server logs, from least to most: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Logs are JSON lines. |
| `PINWALL_WEB_DIR` | the web app bundled with the server | The folder the web app is served from. Leave it unset to use the copy bundled with Pinwall; set it only to serve a build of your own. |

## Content isolation

Artifacts are untrusted pages, so Pinwall serves them apart from the app's own pages. Changing either variable takes a restart.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_ISOLATION` | `single-domain` | Where artifact pages are served from. `single-domain` serves them from the app's own host inside a sandbox and needs nothing extra. `content-domain` gives each version its own host under `PINWALL_CONTENT_ORIGIN`, which isolates artifacts fully but needs a second domain with a wildcard certificate. |
| `PINWALL_CONTENT_ORIGIN` | none; required with `content-domain` | The origin artifacts are served under in `content-domain` mode, such as `https://pinwall-content.example`; each version gets `<token>.<host>`. It must be a domain name, not an IP address, and not the app host or a parent of it, and it must use https when `PINWALL_PUBLIC_ORIGIN` does. A warning is logged when it shares the app's registrable domain. |

## Database

Pinwall keeps its data in SQLite (the default) or PostgreSQL.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_DATABASE_URL`<br>secret · also `PINWALL_DATABASE_URL_FILE` | SQLite at `<data dir>/pinwall.db` | Where Pinwall keeps its data: `sqlite:<path>` (a relative path is inside the data dir) or a `postgres://` or `postgresql://` URL, which may carry a password. PostgreSQL needs `PINWALL_SECRET_KEY` as well. |
| `PINWALL_DATABASE_POOL_SIZE` | `10` | The most PostgreSQL connections one Pinwall process opens, from 1 to 1000. `pinwall backup` and `pinwall restore` open one more, for their lease. Opening a connection, or waiting for a free one when all are busy, fails after 10 seconds. SQLite ignores it. |

## Storage

Artifact files live on the local disk (the default) or in an S3-compatible bucket. The `PINWALL_S3_*` variables apply only with `PINWALL_STORAGE=s3`.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_STORAGE` | `local` | Where artifact files are stored: `local` (the `blobs` folder in the data dir) or `s3` (an S3-compatible bucket, which also needs `PINWALL_S3_BUCKET`). |
| `PINWALL_S3_BUCKET` | none; required with `s3` | The bucket that holds artifact files. Pinwall does not create it. |
| `PINWALL_S3_REGION` | `us-east-1` | The region of the bucket. S3-compatible services that have no regions usually accept the default. |
| `PINWALL_S3_ENDPOINT` | Amazon S3 | The address of an S3-compatible service such as MinIO, as an `http://` or `https://` URL. Leave it unset for Amazon S3. |
| `PINWALL_S3_ACCESS_KEY_ID`<br>secret · also `PINWALL_S3_ACCESS_KEY_ID_FILE` | the credentials of the machine Pinwall runs on (the AWS SDK's default chain) | The access key id Pinwall signs in to the bucket with. Set it together with `PINWALL_S3_SECRET_ACCESS_KEY`, or set neither to use the role or credentials of the environment. |
| `PINWALL_S3_SECRET_ACCESS_KEY`<br>secret · also `PINWALL_S3_SECRET_ACCESS_KEY_FILE` | none; set together with the access key id | The secret that goes with the access key id. The two are set together. |
| `PINWALL_S3_FORCE_PATH_STYLE` | `false` | Put the bucket name in the URL path (`host/bucket`) instead of the host name (`bucket.host`). Many self-hosted S3 services need `true`. |
| `PINWALL_S3_PREFIX` | empty | Text put in front of every object key, so one bucket can be shared. Files are stored as `<prefix>blobs/<sha256>`; end it with a slash for a folder, for example `pinwall/`. |

## Single sign-on

Single sign-on through an OpenID Connect identity provider. It is on when the issuer and the client id are set, and off when neither is. Setting only one of them, or a client secret without them, stops Pinwall at startup.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_OIDC_ISSUER` | none; single sign-on is off | The issuer URL of your OpenID Connect identity provider. It must use `https` unless `PINWALL_OIDC_ALLOW_HTTP_ISSUER` is `true`. Register `<public origin>/auth/oidc/callback` as the redirect URI at the provider, and `<public origin>/auth/oidc/signed-out` as a post-logout redirect URI: "Use a different account" signs a refused person out at the provider first, when it supports that. |
| `PINWALL_OIDC_CLIENT_ID` | none; required with the issuer | The client id Pinwall is registered under at the identity provider. |
| `PINWALL_OIDC_CLIENT_SECRET`<br>secret · also `PINWALL_OIDC_CLIENT_SECRET_FILE` | none; Pinwall then acts as a public client | The client secret for a confidential client. Leave it unset when the provider registered Pinwall as a public client. |
| `PINWALL_OIDC_SCOPES` | `openid email profile offline_access` | The scopes Pinwall asks for at sign-in, separated by spaces or commas. `openid` is required. `offline_access` lets Pinwall re-check someone's access with a refresh token. |
| `PINWALL_OIDC_DISPLAY_NAME` | `Single sign-on` | The text on the sign-in button. |
| `PINWALL_OIDC_EXTRA_AUTH_PARAMS` | empty | Extra query parameters for the sign-in request, written `name=value&name=value`. Google, for one, needs `access_type=offline` before it issues refresh tokens. |
| `PINWALL_OIDC_ALLOW_HTTP_ISSUER` | `false` | Allow an issuer reached over plain `http`. Anyone on the network path to such a provider can forge any identity, admins included, so use it only for tests or a trusted private network. A warning is logged at start. |

## Roles and access

Who the identity provider admits, and as what: admin or member. People who sign in with the owner account are not affected by these.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_OIDC_ROLES_CLAIM` | none; groups are not read | The claim in the sign-in token that lists a person's groups or roles: a string, an array, or an object whose keys are the groups. A dotted name such as `realm_access.roles` reads a nested claim. |
| `PINWALL_OIDC_ADMIN_GROUPS` | none | Groups whose members become admins, separated by commas. Names must match exactly, including case. Requires `PINWALL_OIDC_ROLES_CLAIM`: without it Pinwall does not start. |
| `PINWALL_OIDC_MEMBER_GROUPS` | none | Groups whose members become members, separated by commas. Names must match exactly, including case. Requires `PINWALL_OIDC_ROLES_CLAIM`: without it Pinwall does not start. |
| `PINWALL_ADMIN_EMAILS` | none | Email addresses that become admins, separated by commas. Matched ignoring case, and only when the provider says the email is verified. |
| `PINWALL_MEMBER_EMAILS` | none | Email addresses that become members, separated by commas. Matched ignoring case, and only when the provider says the email is verified. |
| `PINWALL_MEMBER_DOMAINS` | none | Email domains whose verified addresses become members, such as `example.com`. When no member group, email or domain is set, everyone the provider admits is a member. |
| `PINWALL_ACCESS_RECHECK_INTERVAL` | `12h` | How often Pinwall asks the identity provider whether someone still has access, from `5m` to `24h`. Someone removed at the provider loses access by the next check. |

## Spaces and sharing

Whether every member sees every project, or each person has a space of their own. Changing it takes a restart.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_VISIBILITY` | `team` | team: every member sees every project, as in Pinwall 1.0. personal: each person sees only the projects they own or were added to. Going from personal back to team needs pinwall visibility team --confirm once. |
| `PINWALL_SHARE_LINKS` | `members` | members: any member may make share links and open raw links, as in Pinwall 1.0. approved: only admins and the members an admin approved in Admin → Users may; everyone else's pages open only inside Pinwall's viewer. Approve people before switching: links made by others stop opening. |
| `PINWALL_ABUSE_CONTACT` | none | An email address or an http(s) URL where people report abuse. When set, it is shown on share pages, on the pages for links that are gone or not found, and on the sign-in page. |
| `PINWALL_TERMS_URL` | none | An http(s) URL of your terms of use, linked from the sign-in page when set. |
| `PINWALL_PRIVACY_URL` | none | An http(s) URL of your privacy notice, linked from the sign-in page when set. |

## Upload limits

The `*_BYTES` limits accept the size syntax above. A publish that goes over any limit is refused.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_MAX_UPLOAD_BYTES` | `95000000` | The largest single upload request. The default sits under the 100 MB request cap that Cloudflare applies on its Free and Pro plans; raise it only when nothing in front of Pinwall caps requests. |
| `PINWALL_MAX_INLINE_BYTES` | `2000000` | The most content an agent can send inline, inside the request itself, in one publish over MCP. Larger publishes use an upload URL. |
| `PINWALL_MAX_FILE_BYTES` | `50000000` | The largest single file inside an artifact version. |
| `PINWALL_MAX_VERSION_BYTES` | `500000000` | The largest total size of an artifact version once it is unpacked. |
| `PINWALL_MAX_FILES` | `10000` | The most files one artifact version can hold. |
| `PINWALL_MAX_EXPANSION_RATIO` | `100` | How many times larger than its compressed upload a version may unpack to. It stops archive bombs. |
| `PINWALL_QUOTA_BYTES` | `0` | The most a person may store, as the total size of their versions, each counted in full. 0 means no limit. In personal mode it counts the projects a person owns, editors' publishes included; in team mode what they published. Admins have no limit, and an admin can set another value for one person. |
| `PINWALL_QUOTA_ARTIFACTS` | `0` | The most artifacts a person may have, counted like PINWALL_QUOTA_BYTES. 0 means no limit. |
| `PINWALL_QUOTA_FILES` | `0` | The most files a person may store: the files of all their versions, each version's counted in full, in the same space as PINWALL_QUOTA_BYTES. 0 means no limit. Admins have no limit; unlike the other quotas, it cannot be set for one person. |

## Lifetimes

Durations accept the syntax above.

| Variable | Default | Description |
| --- | --- | --- |
| `PINWALL_SESSION_TTL` | `30d` | How long a browser session lasts without use. Each visit extends it, so an active person stays signed in. |
| `PINWALL_PREVIEW_TTL` | `12h` | How long the content access Pinwall grants for viewing an artifact lasts, in the review viewer and in raw links. A share link that expires sooner cuts it short. |
| `PINWALL_UPLOAD_SESSION_TTL` | `10m` | How long a one-time upload URL stays usable after Pinwall hands it out. |

Generated from apps/server/src/config/catalog.ts by pnpm docs:config. Do not edit by hand.
