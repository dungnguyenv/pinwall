# Pinwall Helm chart

The chart installs Pinwall as one hardened pod: a non-root user, a read-only root filesystem, no
capabilities, and a `/data` volume that stays writable through `fsGroup`. The pod is admitted under
the Pod Security "restricted" profile. It needs Kubernetes 1.27 or newer.

Pinwall runs as a single instance in v1. It keeps its state in one SQLite file or one PostgreSQL
database and in the memory of the process, so it scales up and not out, and the chart has no replica
count.

- [Install](#install)
- [Secrets](#secrets)
- [Values](#values)
- [Examples](#examples)
- [What the chart sets and refuses](#what-the-chart-sets-and-refuses)
- [Upgrade, backup and restore](#upgrade-backup-and-restore)
- [Checking the chart](#checking-the-chart)

## Install

```sh
helm install pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version 1.0.0 \
  --set publicOrigin=https://pinwall.example
```

`publicOrigin` is the address people use, as scheme and host with an optional port and no path, and
it is the only value that has to be set. A released chart carries the digest of the image it was
built with, so the pod runs exactly that image. With no `existingSecret` Pinwall uses SQLite on the
data volume and generates its secret key there.

On its first start Pinwall logs a one-time link that creates the owner account:

```sh
kubectl logs deploy/pinwall | grep setup_url
```

## Secrets

A secret never goes in `env`. The database URL, the secret key, the S3 keys and the OIDC client
secret would sit in plain text in the pod spec, so the chart refuses to render them there. Put them
in a Secret that you create in the namespace, and say which key holds which secret:

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

The chart mounts each named key as a file under `/run/secrets/pinwall` and sets the `_FILE` form of
the variable to its path. Only the keys you name are mounted. The secret variables are
`PINWALL_SECRET_KEY`, `PINWALL_DATABASE_URL`, `PINWALL_S3_ACCESS_KEY_ID`,
`PINWALL_S3_SECRET_ACCESS_KEY` and `PINWALL_OIDC_CLIENT_SECRET`. PostgreSQL needs the secret key
and the database URL. SQLite needs none of them.

Every other setting is a `PINWALL_*` variable that goes in `env`. They are listed in
[docs/configuration.md](../../../docs/configuration.md).

## Values

Every value of `values.yaml`, with its default. The file itself has the same descriptions as
comments.

### Image and address

| Value | Default | Description |
| --- | --- | --- |
| `image.repository` | `ghcr.io/dungnguyenv/pinwall` | The image repository. |
| `image.digest` | `""` | The image by content digest, `sha256:` and 64 hex digits. A released chart has it filled in, and it wins over `image.tag`. |
| `image.tag` | `""` | An image tag, used only while `image.digest` is empty. A tag can move, so prefer the digest. With neither, the chart does not render. |
| `image.pullPolicy` | `IfNotPresent` | When the kubelet pulls the image: `Always`, `IfNotPresent` or `Never`. |
| `imagePullSecrets` | `[]` | Secrets for pulling from a private registry, as a list of `{name: <secret>}`. |
| `publicOrigin` | none, required | The address people use to reach Pinwall: `https://pinwall.example`, with no path. Every link, redirect, passkey and cookie setting is built from it. |

### Settings and secrets

| Value | Default | Description |
| --- | --- | --- |
| `env` | `{}` | Settings that are not secret, as `PINWALL_*` variables with a text, number or boolean value. The chart sets `PINWALL_PUBLIC_ORIGIN`, `PINWALL_METRICS_PORT`, `PINWALL_PORT` and `PINWALL_DATA_DIR` itself, and refuses them here. It also refuses the five secret variables and their `_FILE` forms. |
| `existingSecret` | `""` | The name of a Secret that you create in the same namespace. It needs `secretFiles`, and `secretFiles` needs it. |
| `secretFiles` | `{}` | Which key of `existingSecret` holds which secret, as `VARIABLE: key`. Only the five secret variables are accepted. |

### Storage

| Value | Default | Description |
| --- | --- | --- |
| `persistence.enabled` | `true` | Keep `/data` on a volume. With `false` it is an `emptyDir`, and the database, the stored files and the generated secret key are lost whenever the pod restarts, so use that for a trial only. |
| `persistence.existingClaim` | `""` | Use a claim that already exists instead of creating one. |
| `persistence.storageClass` | `""` | The StorageClass of the new claim. Empty uses the cluster's default. |
| `persistence.accessModes` | `[ReadWriteOnce]` | The access modes of the new claim. One pod mounts it at a time. |
| `persistence.size` | `10Gi` | The size of the new claim. |
| `persistence.annotations` | `{}` | Annotations of the new claim. `helm.sh/resource-policy: keep` leaves the volume in place when the release is uninstalled. |

With PostgreSQL and S3 the data volume holds only temporary files, such as upload and backup
spools, but it still has to be writable and large enough for them.

### Network

| Value | Default | Description |
| --- | --- | --- |
| `service.type` | `ClusterIP` | The type of the web Service: `ClusterIP`, `NodePort` or `LoadBalancer`. |
| `service.port` | `80` | The port of the web Service. The container always listens on 8080. |
| `service.annotations` | `{}` | Annotations of the web Service. |
| `ingress.enabled` | `false` | Create an Ingress for the web app. |
| `ingress.className` | `""` | The `ingressClassName`. Empty uses the cluster's default class. |
| `ingress.annotations` | `{}` | Annotations of the Ingress, such as the certificate issuer or the controller's body-size limit. An upload can be as large as `PINWALL_MAX_UPLOAD_BYTES`. |
| `ingress.hosts` | `[]` | The host names to route to Pinwall. Empty uses the host of `publicOrigin`, without its port. |
| `ingress.contentHost` | `""` | With `PINWALL_ISOLATION=content-domain`, the wildcard host that serves artifacts, such as `*.pinwall-content.example`. It adds a rule for that host to the same Service. |
| `ingress.tls` | `[]` | TLS entries as the Ingress spec has them, `{secretName, hosts}`. A content-domain install needs a certificate that covers the wildcard host too. |
| `networkPolicy.enabled` | `false` | Create a NetworkPolicy for the pod. It needs a network plugin that enforces policies. |
| `networkPolicy.ingressFrom` | `[]` | Who may reach the web port, as NetworkPolicy `from` entries, such as the namespace of the ingress controller. Empty lets every source reach it. |
| `networkPolicy.metricsFrom` | `[]` | Who may reach the metrics port, such as the namespace Prometheus runs in. Empty lets nothing reach it. |
| `networkPolicy.restrictEgress` | `false` | Limit what the pod may connect to. With `true` only DNS and the rules in `networkPolicy.egress` are allowed, so list the database, the S3 service and the identity provider there. |
| `networkPolicy.egress` | `[]` | Extra egress rules, as NetworkPolicy egress entries, used with `networkPolicy.restrictEgress`. |

### Metrics

| Value | Default | Description |
| --- | --- | --- |
| `metrics.enabled` | `true` | Serve Prometheus metrics on a port of their own. With `false` there is no metrics listener. |
| `metrics.port` | `9464` | The metrics port. It has to differ from the web port, 8080. The metrics have a ClusterIP Service of their own, so a `LoadBalancer` or `NodePort` web Service never publishes them. |
| `metrics.serviceMonitor.enabled` | `false` | Create a Prometheus Operator ServiceMonitor. It needs `metrics.enabled` and the operator's CRDs. |
| `metrics.serviceMonitor.interval` | `30s` | How often Prometheus scrapes. |
| `metrics.serviceMonitor.labels` | `{}` | Extra labels of the ServiceMonitor, for an operator that selects monitors by label. |

### Pod

| Value | Default | Description |
| --- | --- | --- |
| `resources.requests.cpu` | `100m` | The CPU the pod asks for. |
| `resources.requests.memory` | `256Mi` | The memory the pod asks for. |
| `resources.limits.memory` | `1Gi` | The memory limit. It also bounds the largest upload that can be unpacked (`PINWALL_MAX_VERSION_BYTES`), so raise it with larger limits. There is no CPU limit by default, and `resources.limits.cpu` adds one. |
| `serviceAccount.create` | `true` | Create a ServiceAccount for the pod. Pinwall never calls the Kubernetes API, so the pod mounts no token either way. |
| `serviceAccount.name` | `""` | The name. Empty uses the release's name, or `default` when `serviceAccount.create` is `false`. |
| `serviceAccount.annotations` | `{}` | Annotations of the ServiceAccount, such as a cloud role. |
| `podAnnotations` | `{}` | Annotations of the pod. |
| `podLabels` | `{}` | Extra labels of the pod. |
| `nodeSelector` | `{}` | Node selection for the pod. |
| `tolerations` | `[]` | Tolerations of the pod. |
| `affinity` | `{}` | Affinity of the pod. |
| `nameOverride` | `""` | Replaces the chart's name in the names of its objects. |
| `fullnameOverride` | `""` | Replaces the whole name of its objects. |

## Examples

PostgreSQL and S3 storage, behind an ingress controller, with single sign-on. The Secret has the
keys `secret-key`, `database-url`, `s3-access-key-id`, `s3-secret-access-key` and
`oidc-client-secret`:

```yaml
publicOrigin: https://pinwall.example
env:
  PINWALL_TRUST_PROXY: "true"
  PINWALL_STORAGE: s3
  PINWALL_S3_BUCKET: pinwall
  PINWALL_S3_REGION: eu-central-1
  PINWALL_S3_ENDPOINT: https://s3.example
  PINWALL_S3_FORCE_PATH_STYLE: "true"
  PINWALL_OIDC_ISSUER: https://keycloak.example/realms/main
  PINWALL_OIDC_CLIENT_ID: pinwall
  PINWALL_OIDC_ROLES_CLAIM: groups
  PINWALL_OIDC_ADMIN_GROUPS: pinwall-admins
  PINWALL_OIDC_MEMBER_GROUPS: pinwall-members
existingSecret: pinwall-secrets
secretFiles:
  PINWALL_SECRET_KEY: secret-key
  PINWALL_DATABASE_URL: database-url
  PINWALL_S3_ACCESS_KEY_ID: s3-access-key-id
  PINWALL_S3_SECRET_ACCESS_KEY: s3-secret-access-key
  PINWALL_OIDC_CLIENT_SECRET: oidc-client-secret
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 100m
  tls:
    - secretName: pinwall-tls
      hosts:
        - pinwall.example
```

Content-domain isolation adds a wildcard host to the Ingress, and a certificate for it:

```yaml
env:
  PINWALL_ISOLATION: content-domain
  PINWALL_CONTENT_ORIGIN: https://pinwall-content.example
ingress:
  contentHost: "*.pinwall-content.example"
  tls:
    - secretName: pinwall-tls
      hosts:
        - pinwall.example
        - "*.pinwall-content.example"
```

## What the chart sets and refuses

The Deployment has one replica and the `Recreate` strategy, so the old pod stops before the new one
starts and two never share the data volume. The pod runs as user and group 10001 with `fsGroup`
10001, the `RuntimeDefault` seccomp profile, no privilege escalation, a read-only root filesystem
and every capability dropped. `/tmp` is an `emptyDir`, no service account token is mounted, and
Kubernetes does not inject its service variables, because the one for a Service called `pinwall`
would be `PINWALL_PORT`, which is also a Pinwall setting. The probes are `/healthz` for startup and
liveness and `/readyz` for readiness.

`helm install` and `helm template` refuse, with a message that names the fix:

- a missing `publicOrigin`, or one with a path;
- an `image.digest` that is not `sha256:` and 64 hex digits, or neither a digest nor a tag;
- a secret variable, or its `_FILE` form, in `env`;
- `PINWALL_PUBLIC_ORIGIN`, `PINWALL_METRICS_PORT`, `PINWALL_PORT` or `PINWALL_DATA_DIR` in `env`;
- `secretFiles` without `existingSecret`, `existingSecret` without `secretFiles`, and a
  `secretFiles` name that is not one of the five secret variables;
- `metrics.port` equal to 8080, and `metrics.serviceMonitor.enabled` without `metrics.enabled`.

## Upgrade, backup and restore

```sh
helm upgrade pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version <new version> -f values.yaml
```

Keep your own values in a file, as above, so that each upgrade gets the new chart's defaults, the
image digest among them. Pinwall applies pending database migrations when it starts. Take a backup
before you upgrade, and send it to a file on the machine you run `kubectl` from:

```sh
kubectl exec deploy/pinwall -- pinwall backup --out - > pinwall-$(date +%F).tar
kubectl exec -i deploy/pinwall -- pinwall restore --in - < pinwall.tar
```

The second command restores into an empty installation. The
[backup guide](../../../docs/backup.md) explains what a backup holds and why the secret key is kept
apart from it.

## Checking the chart

`pnpm chart:check` lints the chart, renders it for each file in `ci/`, validates the result against
the Kubernetes schemas and checks the hardening rules above. It needs `helm` and `kubeconform`.
