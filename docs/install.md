# Installing and running Pinwall

How to run Pinwall with Docker, choose how artifacts are isolated, put it behind a proxy or a
Cloudflare Tunnel, install it on Kubernetes and watch it. Every setting is listed in
[configuration.md](configuration.md); sign-in is in [sign-in.md](sign-in.md), backups are in
[backup.md](backup.md), and running Pinwall for people you do not know is in
[open-instance.md](open-instance.md).

- [Docker](#docker)
- [Content isolation](#content-isolation)
- [Behind a proxy or Cloudflare Tunnel](#behind-a-proxy-or-cloudflare-tunnel)
- [Kubernetes](#kubernetes)
- [Monitoring](#monitoring)

## Docker

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
[configuration.md](configuration.md). The folder [deploy/compose/](../deploy/compose/) has
two Compose files: one host with SQLite in a volume, and PostgreSQL with S3 storage.

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

An instance that is open to people you do not know should use a content domain. Strangers' pages
then stay off the domain of the app, so a blocklisted page cannot take the app down with it; see
[a separate content domain](open-instance.md#a-separate-content-domain) in the guide to running an
open instance.

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
helm install pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version <version> \
  --set publicOrigin=https://pinwall.example
```

Use the latest release for `<version>`, as in the [README](../README.md#quick-start). That gives
SQLite on a persistent volume. For PostgreSQL, S3 or single sign-on, put each secret in a Kubernetes
Secret you create, and map its keys to the settings. The chart mounts them as files and refuses a
secret in `env`, where it would sit in plain text in the pod spec:

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

Every value, with its default, is in the [chart reference](../deploy/helm/pinwall/README.md).

## Monitoring

Prometheus metrics are served at `/metrics` on port 9464, a listener apart from the app's port.
Keep that port off the public network; `PINWALL_METRICS_PORT` changes it, and 0 turns it off. The
app also answers `/healthz` and `/readyz`, logs JSON lines, and exposes its REST API as an OpenAPI
document at `/openapi.json`.
