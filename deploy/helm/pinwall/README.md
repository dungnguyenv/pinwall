# Pinwall Helm chart

Installs Pinwall as one hardened pod: a non-root user, a read-only root filesystem, no
capabilities, and a `/data` volume that stays writable through `fsGroup`, so it is admitted under
the Pod Security "restricted" profile. Pinwall runs as a single instance in v1, so the chart has no
replica count.

This page is a short start. `values.yaml` has a comment for every value.

## Install

```sh
helm install pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version <version> \
  --set publicOrigin=https://pinwall.example.com
```

`publicOrigin` is the address people use: scheme and host, no path. It is the only required value.
The chart pins the image by digest. With no `existingSecret`, Pinwall uses SQLite on the data
volume and generates its secret key there.

## Secrets

A secret (the database URL, the secret key, the S3 keys, the OIDC client secret) never goes in
`env`: the chart refuses to render it there, because it would sit in plain text in the pod spec.
Put it in a Secret you create, and name the keys:

```sh
kubectl create secret generic pinwall-secrets \
  --from-literal=secret-key="$(openssl rand -hex 32)" \
  --from-literal=database-url='postgres://pinwall:<password>@postgres:5432/pinwall'
```

```yaml
existingSecret: pinwall-secrets
secretFiles:
  PINWALL_SECRET_KEY: secret-key
  PINWALL_DATABASE_URL: database-url
```

Each key is mounted as a file under `/run/secrets/pinwall`, and the chart sets the variable's
`_FILE` form to it. Settings that are not secret go in `env`, as `PINWALL_*` variables (see
`docs/configuration.md`).

## Checking the chart

`pnpm chart:check` lints the chart, renders it for each file in `ci/`, validates the result against
the Kubernetes schemas and checks the hardening rules. It needs `helm` and `kubeconform`.
