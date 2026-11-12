# Pinwall

Pinwall is a self-hosted home for the pages AI agents make. An agent (Claude Code first, any MCP
client after) publishes an HTML page, a folder of pages or a Markdown document. You open it, look
at it at phone, tablet and desktop widths, pin comments on it, and share it with people outside
your team through a link that can carry a password and an expiry date.

Every publish becomes a numbered version that never changes. Comments stay tied to the version
they were written on. The agent reads them over MCP, fixes the page, publishes the next version
and marks what it fixed as resolved, while the review tab you left open switches to the new version
by itself. Pinwall runs as one container, with SQLite and local disk or with PostgreSQL and
S3-compatible storage. It sends no telemetry, and it leaves identity and groups to your OpenID
Connect provider, or to a built-in owner account when it is only you.

- [Quick start](#quick-start)
- [Connect an agent](#connect-an-agent)
- [Content isolation](#content-isolation)
- [Sign-in](#sign-in)
- [Behind a proxy or Cloudflare Tunnel](#behind-a-proxy-or-cloudflare-tunnel)
- [Kubernetes](#kubernetes)
- [Backup and restore](#backup-and-restore)
- [Moving from SQLite and local disk to Postgres and S3](#moving-from-sqlite-and-local-disk-to-postgres-and-s3)
- [Metrics, security and license](#metrics-security-and-license)

## Quick start

```sh
docker run -v pinwall:/data -p 8080:8080 ghcr.io/dungnguyenv/pinwall
```

That starts Pinwall in the foreground with everything it keeps (the SQLite database, the uploaded
files and a generated secret key) in a Docker volume named `pinwall`. No owner account exists yet,
so Pinwall prints a one-time setup link:

```text
Pinwall setup: open http://localhost:8080/setup?token=… to create the owner account
```

Open it, give the owner account a name and a password or a passkey, and you are in. The link works
for 24 hours. If it has expired or you lost it, restart the container: every start without an owner
prints a new link and retires the previous one.

To run in the background, add `-d --name pinwall` to the command. Then the link is in the log, as
the `setup_url` field of a JSON line. `<name>` is the container's name, `pinwall` with those flags:

```sh
docker logs <name> 2>&1 | grep setup_url
```

Once you are in, you can publish from the web app by dragging a file, a folder or an archive onto
it, and agents can publish over MCP.

The image runs as user 10001 and only needs `/data` to be writable, so `--read-only --tmpfs /tmp`
works too. When `/data` is a bind-mounted folder instead of a named volume, that folder must be
writable by user 10001.

**Set the address people use.** Pinwall builds every link, redirect, cookie flag and passkey from
`PINWALL_PUBLIC_ORIGIN`, which defaults to `http://localhost:8080`. That is right for a trial on one
machine. Anywhere else, whether behind a reverse proxy or tunnel or on a server people reach by
name, set it to the real address (scheme and host, no path) before you create the owner account:

```sh
docker run -v pinwall:/data -p 8080:8080 \
  -e PINWALL_PUBLIC_ORIGIN=https://pinwall.example \
  ghcr.io/dungnguyenv/pinwall
```

An https origin turns on secure cookies and HSTS. Passkeys belong to the host name of the origin,
so a passkey made for one address does not work from another.

Every setting is an environment variable, listed with its default in
[docs/configuration.md](docs/configuration.md). The folder [deploy/compose/](deploy/compose/) has
two Compose files: one host with SQLite in a volume, and PostgreSQL with S3 storage.

## Connect an agent

In Claude Code, with your own address in place of `https://pinwall.example`:

```sh
claude mcp add --transport http pinwall https://pinwall.example/mcp
```

Then type `/mcp`, pick **pinwall** and sign in, which opens your browser on Pinwall. Pinwall is the
OAuth server for its own MCP endpoint, so nothing is installed and no token is pasted. The address
must be your `PINWALL_PUBLIC_ORIGIN` followed by `/mcp`.

An agent with a shell publishes a folder through a one-time upload URL that expires within minutes,
so no long-lived secret sits in its shell. One without a shell, such as Claude Desktop, can publish
text files inline.
[docs/connect-an-agent.md](docs/connect-an-agent.md) covers Cursor, Codex, other clients, API tokens
for clients without OAuth, and the Pinwall skill for Claude Code. The **Connect an agent** page
inside Pinwall shows the same snippets with your address filled in. What a page may and may not do
is in [docs/authoring.md](docs/authoring.md).

## Content isolation

An artifact is a page an agent wrote, so Pinwall treats it as untrusted code, and it must never run
with the session of the app. There are two ways to keep it apart, chosen with `PINWALL_ISOLATION`.

**Single domain** (`single-domain`, the default) serves pages from the same host as the app, under
`/c/<token>/`, with a `Content-Security-Policy: sandbox` header and without `allow-same-origin`. The
browser gives such a page an origin of its own that matches nothing: it can run scripts and load
its own files, but it cannot read or set the app's cookies and cannot use cookies, `localStorage`
or IndexedDB of its own. It needs nothing beyond what you already have. The trade-off is that this
is a sandbox inside one site, which is weaker than two separate sites, and that pages cannot keep
state in the browser.

**Content domain** (`content-domain`) serves every version from a host of its own,
`<token>.<content domain>`, on a second domain that you use for nothing else. The browser then
separates the app from the pages, and the pages from each other, by origin, which is the strongest
isolation and the one to choose for a team. It needs a second domain, a wildcard DNS record for it
and a wildcard certificate. Set both variables:

```sh
PINWALL_ISOLATION=content-domain
PINWALL_CONTENT_ORIGIN=https://pinwall-content.example
```

The content origin must be a domain name, not an IP address, and not the app's host or a parent of
it. When the app is on https, the content origin must be on https too: a browser blocks http frames
inside an https page, so Pinwall refuses to start rather than show blank reviews. Pinwall logs a warning when it shares the app's registrable domain, which weakens the
separation.

Switching is a change of those variables and a restart. The links people hold, to an artifact or
through a share link, are addresses on the app origin that open the content in whichever mode is
running, so every one of them keeps working after the restart. The address of the page itself, with
a long token in it, is short-lived, so share the artifact's link from the app instead.

## Sign-in

The built-in **owner account** needs no identity provider. You create it with the setup link from
the quick start, with a passkey or a password, and it is always an admin. Everyone else signs in
through an OpenID Connect provider, once you set `PINWALL_OIDC_ISSUER` and `PINWALL_OIDC_CLIENT_ID`.
Single sign-on stays off while neither is set. Setting only one of them, or a client secret without
them, stops Pinwall at startup with a message that names what is missing.

Pinwall does not manage groups. It reads them from the provider and maps them to two roles, admin
and member. Group rules read the claim that `PINWALL_OIDC_ROLES_CLAIM` names, and Pinwall refuses to
start with group rules but no such claim. At the provider, register Pinwall with this redirect URI,
which is your public origin plus `/auth/oidc/callback`:

```text
https://pinwall.example/auth/oidc/callback
```

Also register this post-logout redirect URI, so that **Use a different account** works when someone
who signed in has no access to Pinwall: Pinwall signs them out at the provider first, then the
provider asks again who is signing in. A provider that does not allow the address shows its own
error page instead.

```text
https://pinwall.example/auth/oidc/signed-out
```

By default Pinwall asks for the scopes `openid email profile offline_access`. The refresh token
that `offline_access` brings lets it check again, every `PINWALL_ACCESS_RECHECK_INTERVAL` (12 hours
by default, never more than 24), that someone still has access. A person removed at the provider
loses access by the next check, with no admin action, and an admin can end a person's browser
sessions, MCP tokens and API tokens with **Revoke now** under **Admin, Users**. Their next request
is refused. A live-update stream they already have open, such as a review page left open, is
checked again within 25 seconds, and until then it can still bring them new comments. Revoke now,
a block, or a check that finds the provider gives someone no role also revokes every share link that
person made, for good. Their links also stop opening whenever their own access lapses, for instance
when a check is overdue or the provider refused it, and open again once they sign in.

Put the client secret in a file and give its path in `PINWALL_OIDC_CLIENT_SECRET_FILE`. A person who
signs in successfully but earns no role is refused. A role an admin sets on the Users page replaces
the provider's only while the provider still lets the person in: once it drops them they lose access
like anyone else, and the role applies again if it takes them back. A block always applies.

### Zitadel

1. In your Zitadel project, add the roles `pinwall-admin` and `pinwall-member`, switch on **Assert
   Roles on Authentication** in the project's settings, and give each person one of the roles.
2. Add an application of type **Web** that uses the code flow, with the grant types **Authorization
   Code** and **Refresh Token**, the redirect URI `https://pinwall.example/auth/oidc/callback`
   and the post logout URI `https://pinwall.example/auth/oidc/signed-out`.
   Copy the client id, and the client secret if you chose a method that has one.
3. Give Pinwall these variables. The roles arrive in a claim whose keys are the role names.

```sh
PINWALL_OIDC_ISSUER=https://zitadel.example
PINWALL_OIDC_CLIENT_ID=<client id>
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Zitadel
PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles
PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin
PINWALL_OIDC_MEMBER_GROUPS=pinwall-member
```

### Keycloak

1. Create a client of type OpenID Connect with **Client authentication** on, so that it is
   confidential, and with the standard flow only. Add the redirect URI
   `https://pinwall.example/auth/oidc/callback`, and set the advanced setting **Proof Key for Code
   Exchange Code Challenge Method** to `S256`. Under **Valid post logout redirect URIs**, add
   `https://pinwall.example/auth/oidc/signed-out`. The client secret is on its **Credentials** tab.
2. Create two groups, for example `pinwall-admins` and `pinwall-members`, and put people in them.
3. Under the client's dedicated scope, add a mapper of type **Group Membership** named `groups`,
   with the token claim name `groups`, **Full group path** off, and the claim added to the ID
   token and to the userinfo response. With the full path on, a group arrives as `/pinwall-admins`,
   which does not match the name you give Pinwall.
4. Pinwall asks for `offline_access`. Keycloak allows it for a new client, and for people who keep
   the realm's default roles.

```sh
PINWALL_OIDC_ISSUER=https://keycloak.example/realms/main
PINWALL_OIDC_CLIENT_ID=pinwall
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Keycloak
PINWALL_OIDC_ROLES_CLAIM=groups
PINWALL_OIDC_ADMIN_GROUPS=pinwall-admins
PINWALL_OIDC_MEMBER_GROUPS=pinwall-members
```

Pinwall's own CI signs in through a real Keycloak 26 set up exactly like this, with an admin, a
member and a person in no group.

### Google

Google has no groups claim, and it refuses the `offline_access` scope. Pinwall therefore takes
roles from lists of verified email addresses, and asks for a refresh token the way Google wants it.

1. In the Google Cloud console, create an OAuth client of type **Web application** and add
   `https://pinwall.example/auth/oidc/callback` as an authorized redirect URI.
2. Give Pinwall these variables:

```sh
PINWALL_OIDC_ISSUER=https://accounts.google.com
PINWALL_OIDC_CLIENT_ID=<client id>.apps.googleusercontent.com
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Google
PINWALL_OIDC_SCOPES=openid email profile
PINWALL_OIDC_EXTRA_AUTH_PARAMS=access_type=offline&prompt=consent
PINWALL_ADMIN_EMAILS=you@example.com
PINWALL_MEMBER_DOMAINS=example.com
PINWALL_MEMBER_EMAILS=friend@gmail.com
```

`PINWALL_ADMIN_EMAILS` makes those addresses admins. `PINWALL_MEMBER_DOMAINS` makes every
address in those domains a member, and `PINWALL_MEMBER_EMAILS` adds single addresses. Only an
address that Google reports as verified counts. Set at least one member list: when none of the
member groups, emails and domains is set, Pinwall makes everyone that Google signs in a member,
and any Google account can sign in.

## Behind a proxy or Cloudflare Tunnel

Run Pinwall behind a proxy or tunnel that ends TLS, and tell it two things:

```sh
PINWALL_PUBLIC_ORIGIN=https://pinwall.example
PINWALL_TRUST_PROXY=true
```

`PINWALL_PUBLIC_ORIGIN` is the address people use. `PINWALL_TRUST_PROXY=true` makes Pinwall believe
`X-Forwarded-For` from exactly one proxy in front of it, so that what Pinwall limits per address
sees each visitor instead of the proxy: the rate limits, such as those on the owner's sign-in and
on share-link passwords, and the 20 live-update streams one address may hold open. With two proxies
in a row, such as a Cloudflare Tunnel and an ingress controller, list their addresses or ranges
instead, as in `PINWALL_TRUST_PROXY=10.0.0.0/8`. Without it Pinwall ignores forwarded headers, so
everyone behind the proxy has the proxy's address: the rate limits count all visitors together, and
20 open review tabs across the whole team fill the stream limit. Pinwall never takes a host name
from forwarded headers in either case.

Let the proxy pass the `Authorization` header through as the client sent it, and add none of its
own. Pinwall reads that header as a bearer token whenever it is there, so a login that the proxy
asks for with HTTP Basic authentication makes every API and MCP request fail with 401, the web
app's own included, since the browser then sends the Basic credentials with each request. Put such
a login on another layer, such as Cloudflare Access or a VPN.

What to know about Cloudflare:

- Content responses carry `Cache-Control: no-transform`, which keeps Cloudflare from rewriting the
  pages. Do not remove it with a Transform Rule or a Worker, or the pages reach people changed.
- Leave Rocket Loader off. It injects a script that the app's Content-Security-Policy blocks.
- Free and Pro plans refuse a request body over 100 MB. The default upload limit,
  `PINWALL_MAX_UPLOAD_BYTES`, is 95 MB so that it stays under that cap. Raise it only when nothing
  in front of Pinwall caps requests, such as a plan with a higher limit.
- The live updates in the review tab use a long-lived stream. Pinwall sends a heartbeat on it every
  25 seconds, well inside the time after which proxies drop an idle connection.
- In content-domain mode, put the content domain in a zone of its own, with a one-level wildcard
  record such as `*.pinwall-content.example`. Cloudflare's Universal SSL certificate covers a
  one-level wildcard, which is all that Pinwall needs.

## Kubernetes

The Helm chart installs one hardened pod: non-root, read-only root filesystem, no capabilities,
and an image pinned by digest. Pinwall runs as a single instance in v1, so the chart has no
replica count.

```sh
helm install pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version 1.0.0 \
  --set publicOrigin=https://pinwall.example
```

That gives SQLite on a persistent volume. For PostgreSQL, S3 or single sign-on, put each secret in
a Kubernetes Secret you create, and map its keys to the settings. The chart mounts them as files and
refuses a secret in `env`, where it would sit in plain text in the pod spec:

```sh
kubectl create secret generic pinwall-secrets \
  --from-literal=secret-key="$(openssl rand -hex 32)" \
  --from-literal=database-url='postgres://pinwall:<password>@postgres:5432/pinwall'
```

```yaml
publicOrigin: https://pinwall.example
existingSecret: pinwall-secrets
secretFiles:
  PINWALL_SECRET_KEY: secret-key
  PINWALL_DATABASE_URL: database-url
env:
  PINWALL_TRUST_PROXY: "true"
```

Every value, with its default, is in the [chart reference](deploy/helm/pinwall/README.md).

## Backup and restore

`pinwall backup` writes one archive: a consistent snapshot of the database and every file that a
version uses, whatever the storage setup. Write it to standard output and keep it on the machine
you run the command from:

```sh
docker exec pinwall pinwall backup --out - > pinwall-$(date +%F).tar
```

Never add `-t` to `docker exec` here. A terminal rewrites line endings in the stream and ruins the
archive, so `pinwall backup --out -` refuses to write to one. A backup first writes the tables to temporary files under `/data/tmp`, so keep some room
in the data volume. On Kubernetes:

```sh
kubectl exec deploy/pinwall -- pinwall backup --out - > pinwall-$(date +%F).tar
```

Run the backup in the server's container, as these commands do, or with the server's own image. A
backup never migrates the database, so a newer or older Pinwall refuses to back it up.

`pinwall restore` rebuilds an installation from an archive, into any storage setup, as long as the
target is empty (a new volume, or an empty database and bucket prefix). It refuses a target that is
not empty before it changes anything there, so a restore pointed at a database in use by mistake
does not even migrate it. It checks the whole archive before it writes anything:

```sh
docker exec -i <new container> pinwall restore --in - < pinwall.tar
kubectl exec -i deploy/pinwall -- pinwall restore --in - < pinwall.tar
```

Let nobody sign in to the new installation until the restore logs `restore complete`. If someone
signs in or publishes there meanwhile, the restore stops without restoring anything, and the target
is no longer empty.

What to know about the archive:

- It holds the whole database: accounts, password hashes, passkeys, sessions, API and OAuth tokens
  (as hashes), projects, artifacts, versions, comments, share links, and every stored file. It is
  as sensitive as the database, so store and move it that way.
- Deleting an artifact, a version or a comment removes it from the running installation and from its
  storage. It stays in every backup made before, and a restore of such a backup brings it back. When
  something secret was published, delete the older backups too.
- It does not hold the secret key. Pinwall derives its encryption and signing keys from
  `PINWALL_SECRET_KEY`, or from the `secret.key` file that it generates in the data folder, and
  uses them for the identity provider's refresh tokens and for the unlock of password-protected
  share links. Back the key up separately, next to the archive but not inside it. Restore with a
  different key and the single sign-on users have to sign in again, which the restore warns about.

## Moving from SQLite and local disk to Postgres and S3

A backup restores into any storage setup, which makes it the way from the default install to a
larger one. The Compose file
[deploy/compose/docker-compose.postgres-s3.yml](deploy/compose/docker-compose.postgres-s3.yml)
shows the target: PostgreSQL, an S3-compatible service and Pinwall. Its S3 service is `pgsty/silo`,
a maintained fork of MinIO, because MinIO's community images can no longer be pulled. Any
S3-compatible store works in its place.

1. **Back up** the old install: `docker exec pinwall pinwall backup --out - > pinwall.tar`. After
   this, publish nothing more to the old install, because the new one will not have it.
2. **Read the old secret key** as hex into a file:

   ```sh
   docker exec pinwall od -An -tx1 -v /data/secret.key | tr -d ' \n' > secret_key
   ```

3. **Start the Postgres and S3 stack** with that key. In the Compose file's secrets folder, put the
   contents of `secret_key` in the file `secret-key` instead of generating a new key. That file
   is what `PINWALL_SECRET_KEY_FILE` points at. On Kubernetes, put it in the `secret-key` entry of
   your Secret. Use the address of the old install as `PINWALL_PUBLIC_ORIGIN`, since that is the
   one people will reach it at.
4. **Restore** into the new, empty install:
   `docker exec -i <new container> pinwall restore --in - < pinwall.tar`. A Compose container is
   named `pinwall-pinwall-1`. The restore logs what it moved, and prints a warning if it could not
   keep single sign-on users signed in.
5. **Check** `/readyz` on the new install (the Compose file publishes the port on `127.0.0.1`, and
   `PINWALL_PORT_PUBLISHED` moves it while the old install still holds 8080), then **switch DNS**
   or your proxy to it. Open an artifact and a share link. Keep the old volume for a while in case
   you need to go back.

Without the old key, the restore still works, and everyone who signs in through single sign-on has
to sign in again. The owner account and its passkeys are not affected.

## Metrics, security and license

Prometheus metrics are served at `/metrics` on port 9464, a listener apart from the app's port.
Keep that port off the public network; `PINWALL_METRICS_PORT` changes it, and 0 turns it off. The
app also answers `/healthz` and `/readyz`, logs JSON lines, and exposes its REST API as an OpenAPI
document at `/openapi.json`.

In short, on security: pages are sandboxed or served from separate origins, and reached only through
unguessable capability tokens and never through a cookie. Requests that change something and use a
cookie must come from the public origin. Session, API, OAuth and share-link tokens are stored as
hashes. Pinwall sends nothing to anyone: no telemetry, and no request to any third party except the
identity provider and the storage you configure. The image runs as a non-root user on a read-only
filesystem. [SECURITY.md](SECURITY.md) says how to report a vulnerability, describes the model in
more detail and shows how to verify a release. [CONTRIBUTING.md](CONTRIBUTING.md) is for people who
want to change the code.

Pinwall is licensed under the Apache License 2.0 (Apache-2.0), see `LICENSE`. The licenses of the
third-party packages that ship with it are in `THIRD_PARTY_NOTICES`, which is in the image at
`/app/THIRD_PARTY_NOTICES` and attached to every release.
