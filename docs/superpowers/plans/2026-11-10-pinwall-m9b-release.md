# Pinwall M9b — Release: Licenses, Image, Chart, Docs, Release Workflow, Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pinwall releasable as v1:
- an automated license check and generated `THIRD_PARTY_NOTICES`;
- a multi-arch, non-root, read-only image under a size gate;
- a hardened Helm chart and a Postgres + S3 Compose example;
- the user docs;
- a tag-driven release workflow (signed image and chart, provenance, SBOM, GitHub release) that is validated but never run;
- a real-Keycloak sign-in test;
- one `pnpm test:acceptance` for spec §9, plus a written checklist for the manual items.

**Architecture:**
- **`tools/`** is a new private workspace package (`@pinwall/tools`). It holds the license check, notices, image size, chart check, release helpers and acceptance runner, each with Vitest tests.
- **CI:** `.github/workflows/ci.yml` gains one job per deliverable and becomes reusable (`workflow_call`).
- **Release:** `.github/workflows/release.yml` calls CI first, then builds, signs, attests and publishes.
- **End-to-end:** the Playwright suites start the built image or real services in Docker.

**Tech Stack:** Docker Buildx + QEMU, Helm 4.3 + kubeconform 0.8, `yaml` (ISC), Playwright 1.65, Vitest, actionlint 1.7.
- GitHub Actions: cosign keyless, `actions/attest-build-provenance`, `actions/attest-sbom`, and syft through `anchore/sbom-action`.
- Keycloak 26 (`quay.io/keycloak/keycloak:26.8.2`).
- esbuild metafiles and a Vite 8 `generateBundle` plugin.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` (§3.1 Helm/Compose, §3.13, §6, §7, §9 acceptance 1–10).

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Its Global Constraints apply to every task.

**Split:** Task numbers continue from M9a (`2026-11-10-pinwall-m9a-ops.md`, Tasks 1–6). Read its "Interface handed to M9b".

**Depends on:**
- M9a, for the backup, restore and version commands, `PINWALL_VERSION`, metrics and `CONFIG_VARS`.
- Every earlier plan:
  - M1: the Dockerfile and CI job.
  - M3: the no-access copy and the flow suite.
  - M4b and M5: the REST routes and flow suites.
  - M5: `bundleAnnotator` and the annotator e2e.
  - M6: the `agent-flow` suite and `docs/connect-an-agent.md`.
  - M7b: `startPinwall`, the web labels and `test:e2e`.
  - M8b: `test:e2e:review`.

Where merged code differs in a name or signature, the code wins.

## Global Constraints

The roadmap's Global Constraints apply, plus these for M9b:
- **Image:** `ghcr.io/dungnguyenv/pinwall`, platforms `linux/amd64,linux/arm64`, user `10001:10001`, read-only root filesystem. The compressed size must be `< 200_000_000` bytes per platform, or the build fails.
- **Chart:** `deploy/helm/pinwall`, pushed as `oci://ghcr.io/dungnguyenv/charts/pinwall`. Chart `version` = `appVersion` = the release version, and the image is referenced by digest.
- **Workflows:**
  - Pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment. Look the SHA up with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`.
  - Top-level `permissions` is `contents: read` or `{}`, widened per job only.
  - Checkout uses `persist-credentials: false`.
  - Event data never goes into `run:` through `${{ }}`; pass it through `env:`.
  - No `pull_request_target`, and no secret other than `GITHUB_TOKEN`.
  - Docker images that a workflow runs are pinned by digest.
- **Nothing is pushed, tagged or released during M9.** Workflows are verified with `actionlint` and local builds only.
- **Version** `1.0.0` (SemVer) in every `package.json` and in `Chart.yaml`, from Task 11.
- **Licenses**, from the roadmap:
  - What ships (server bundle, SPA, annotator, runtime `node_modules`) may use only MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, Unicode-3.0, Unicode-DFS-2016, Python-2.0, PSF-2.0.
  - Build- and test-only packages may also be MPL-2.0.
  - Anything else needs an entry with a reason in `tools/license-exceptions.json`.
- **`tools/` CLIs** run as `pnpm --filter @pinwall/tools exec tsx src/<name>.ts …`. They resolve relative paths against the repository root (the nearest parent holding `pnpm-workspace.yaml`), never against `tools/`.
- **Docs are original writing.** Never copy text from another project. M9 ships no code of conduct.

## Review Focus

1. **The image on an arm64 host** (Graviton, a Raspberry Pi, Apple silicon). The JS build runs on the build platform, so the native SQLite binary must be the target's. Expected: the arm64 image migrates a database. → Task 8, CI and Step 5 `migrate` smoke under `--platform linux/arm64`.
2. **A cluster enforcing the Pod Security "restricted" profile, on a volume owned by root.** Expected: the pod is admitted (non-root, seccomp RuntimeDefault, drop ALL, no privilege escalation), and `/data` is writable through `fsGroup: 10001`. → Task 9 `chartInvariants` on every render.
3. **A secret put in the chart's `env:`**, where it would sit in plain text in the pod spec. Expected: rendering fails with a message pointing at `existingSecret`/`secretFiles`. → Task 9 negative renders.
4. **A tag that does not match the versions in the repository**, or a changelog without the version. Expected: the release stops in `verify` before anything is built or pushed. → Task 11 `checkVersions` and `releaseNotes` tests.
5. **Switching accounts at a real IdP.** "Use a different account" must make Keycloak show its login form, not silently reuse the unadmitted session. → Task 12 `an unadmitted user sees who signed in and can switch accounts`.

---

### Task 7: `tools/` package, license check and `THIRD_PARTY_NOTICES` (model: sonnet)

**Files:**
- Create:
  - `tools/{package.json,tsconfig.json,vitest.config.ts,license-exceptions.json}`;
  - `tools/src/{spdx.ts,licenses.ts}`;
  - `tools/test/{spdx,licenses}.test.ts` and the fixtures under `tools/test/fixtures/`;
  - `apps/web/vite-bundled-modules.ts`.
- Modify:
  - `pnpm-workspace.yaml` (add `tools`);
  - root `package.json` scripts: `"licenses:check": "pnpm --filter @pinwall/tools exec tsx src/licenses.ts check"`, `"licenses:notices": "pnpm --filter @pinwall/tools exec tsx src/licenses.ts notices"`;
  - `apps/server/build.mjs` (esbuild `metafile: true`; write `apps/server/.build/bundles.json`);
  - `packages/annotator/bundle.mjs` (add `bundleAnnotatorWithInputs`);
  - `apps/web/vite.config.ts` (add the plugin);
  - `.gitignore` (`.build/`);
  - `NOTICE` (one line: `Third-party components bundled with Pinwall and their licenses are listed in THIRD_PARTY_NOTICES, which ships in the container image and with each release.`);
  - `.github/workflows/ci.yml` (job `licenses`).

  The roadmap already names `tools/` in its layout and `THIRD_PARTY_NOTICES` in its license constraint; both were edited together with this plan.

**Interfaces:**
- Consumes: M5 `bundleAnnotator`; M1 `build.mjs`.
- Produces:

```ts
// packages/annotator/bundle.mjs (adds; bundleAnnotator keeps its signature and returns .code)
export function bundleAnnotatorWithInputs(): Promise<{ code: string; inputs: string[] }>;   // esbuild metafile input paths, absolute
// tools/src/spdx.ts
export function satisfiesLicense(expression: string, allowed: ReadonlySet<string>): boolean;
  // SPDX expression: OR = any side, AND = both, WITH <exception> = its base id, trailing '+' dropped, parentheses, ids case-insensitive;
  // unparsable, 'UNLICENSED', 'SEE LICENSE IN …', empty → false
// tools/src/licenses.ts
export const SHIPPED_ALLOWED: ReadonlySet<string>;      // the Global Constraints list
export const BUILD_ONLY_ALLOWED: ReadonlySet<string>;   // SHIPPED_ALLOWED + MPL-2.0
export interface PackageInfo { name: string; version: string; license: string | null; dir: string; shippedIn: ('server' | 'web' | 'annotator' | 'runtime')[] }
export function packageOfModule(file: string): Promise<{ name: string; version: string; license: string | null; dir: string } | null>;
  // walks up to the nearest package.json with name and version (skips {"type":"module"} stubs); workspace @pinwall/* and '\0' virtual ids → null
export function shippedPackages(root: string, o?: { runtimeDir?: string }): Promise<PackageInfo[]>;
  // apps/server/.build/bundles.json { server, annotator } + apps/web/.build/modules.json + 'tailwindcss' (compiled into the SPA's CSS)
  // + runtime: each package under o.runtimeDir, else better-sqlite3 and its production dependencies minus node-addon-api (what the Dockerfile copies)
export function installedPackages(root: string): Promise<PackageInfo[]>;   // `pnpm licenses list --json` (dev included)
export type LicenseExceptions = Record<string, { license: string; reason: string; text?: string }>;   // key 'name' or 'name@version'
export function checkLicenses(shipped: PackageInfo[], installed: PackageInfo[], ex: LicenseExceptions): string[];   // one problem per line, [] = pass
export function renderNotices(shipped: PackageInfo[], ex: LicenseExceptions, version: string): Promise<string>;
  // header 'Pinwall <version> — third-party notices' + one paragraph; per package sorted by name: a rule line, `<name> <version> — <license>`,
  // `Included in: server, web`, the package's LICENSE*/LICENCE*/COPYING* text, then its NOTICE* text; no text file and no ex.text → throws naming the package
// CLI: tsx src/licenses.ts check | notices --out <file> [--runtime-dir <dir>]   (notices also runs the shipped check and fails on a problem)
```

  `apps/server/.build/bundles.json` holds repo-relative paths from the esbuild metafiles of the server and the annotator. `apps/web/.build/modules.json` holds repo-relative module ids, collected from every output chunk's `moduleIds` in the plugin's `generateBundle`. Neither file is under a served directory.

- [ ] **Step 1: Write the failing tests**:

```ts
test.each([
  ['MIT', true], ['(MIT OR GPL-3.0-only)', true], ['MIT AND GPL-2.0-only', false], ['Apache-2.0 WITH LLVM-exception', true],
  ['GPL-2.0+', false], ['mit', true], ['UNLICENSED', false], ['SEE LICENSE IN LICENSE.md', false], ['', false], ['(MIT', false],
])('satisfiesLicense(%j) is %s for shipped code', (expr, ok) => expect(satisfiesLicense(expr, SHIPPED_ALLOWED)).toBe(ok));
test('MPL-2.0 is allowed only for build-only packages', ...);
  // checkLicenses([pkg('lightningcss','MPL-2.0',['web'])], [], {}) → 1 problem naming lightningcss; as installed-only → []
test('GPL and missing licenses fail unless excepted', ...);   // installed 'x' GPL-3.0-only → problem; license null → problem; exception for 'x' → []
test('packageOfModule finds the real package behind pnpm paths and type stubs', ...);
  // fixture node_modules/.pnpm/a@1.0.0/node_modules/a/{package.json,dist/esm/package.json {"type":"module"},dist/esm/x.js} → { name 'a', version '1.0.0' }
test('notices carry license and NOTICE texts, sorted and de-duplicated', ...);   // fixtures b, a (with NOTICE), a again → 'a' before 'b', a's NOTICE text included once
test('a package without license text fails the notices', ...);
```

- [ ] **Step 2: Run** `pnpm install && pnpm --filter @pinwall/tools test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `tools/package.json`: `@pinwall/tools`, private, `"type": "module"`, `"license": "Apache-2.0"`, `engines.node >=24`, `"test": "vitest run"`, devDeps `tsx vitest typescript @types/node yaml`. Run the check; build-only packages outside the list then go into `license-exceptions.json` with a reason (for example `caniuse-lite` CC-BY-4.0: "browser support data read by build tools; never bundled"). Shipped packages are never excepted without asking the controller. The CI job `licenses` runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm licenses:check`.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/tools test && pnpm build && pnpm licenses:check && pnpm licenses:notices --out "$(mktemp)"`. Expected:
  - PASS, then `0 problems`;
  - the notices file has sections for `hono`, `react`, `zod`, `better-sqlite3`, `tailwindcss` and `@prometheus-io/client`, and contains no `@pinwall/`.

  Then run `pnpm lint && pnpm typecheck && actionlint`. Expected: clean.
- [ ] **Step 5: Commit** `build: add a license check and generated third-party notices`.

### Task 8: Multi-arch image with notices and a size gate (model: sonnet)

**Files:**
- Create: `tools/src/image-size.ts`, `tools/test/image-size.test.ts`
- Modify: `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml` (job `image`), root `package.json` (`"image:size": "pnpm --filter @pinwall/tools exec tsx src/image-size.ts"`)

**Interfaces:**
- Consumes: Task 7 `licenses.ts notices --runtime-dir`; Task 1 `PINWALL_VERSION` (via `build.mjs`).
- Produces: image layout as M1, plus `/app/LICENSE`, `/app/NOTICE` and `/app/THIRD_PARTY_NOTICES`; build args `PINWALL_VERSION` and `PINWALL_REVISION`; OCI labels `org.opencontainers.image.{title=Pinwall,description,licenses=Apache-2.0,source=https://github.com/dungnguyenv/pinwall,version,revision}`.

```ts
export const MAX_COMPRESSED_BYTES = 200_000_000;
export function compressedSize(image: string, save?: (image: string) => Readable): Promise<number>;
  // save defaults to the stdout of `docker save <image>`; piped through zlib gzip level 6, bytes counted
// CLI: tsx src/image-size.ts <image> [--max <bytes>] → prints `<image>: <n> bytes compressed (≈ <MB> MB)`; exit 1 when n >= max
```

- [ ] **Step 1: Write the failing test:** `image-size.test.ts` passes a `save` that returns a stream of 1 MiB of zeros. It checks that `compressedSize` returns the gzip length and that the CLI exits 1 with `--max 10`.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/image-size`. Expected: FAIL.
- [ ] **Step 3: Change the Dockerfile:**
  - **Base images.** Both are pinned to the index digest of `node:24-bookworm-slim` (`docker buildx imagetools inspect node:24-bookworm-slim --format '{{json .Manifest.Digest}}'`, today `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`).
  - **Build stage** `FROM --platform=$BUILDPLATFORM …`. Add `COPY tools/package.json tools/` to the manifest layer. Declare `ARG TARGETARCH` only at the assembly `RUN`, so install and build layers are shared between platforms. Keep `prebuilds/linux-x64.node` for `amd64` and `prebuilds/linux-arm64.node` for `arm64`; any other arch fails the build. After assembling `/runtime`, run `pnpm --filter @pinwall/tools exec tsx src/licenses.ts notices --runtime-dir /runtime/node_modules --out /runtime/THIRD_PARTY_NOTICES`, then copy `LICENSE` and `NOTICE` into `/runtime`.
  - **Runtime stage.** Remove npm, npx, corepack and yarn: `/usr/local/lib/node_modules/{npm,corepack}`, `/usr/local/bin/{npm,npx,corepack,yarn,yarnpkg}`, `/opt/yarn-*`. Add the labels, and keep M1's user, volume, ports, healthcheck, entrypoint and `pinwall` wrapper.
  - **`.dockerignore`** keeps `tools/` in the context.
- [ ] **Step 4: Write the CI job `image`:**
  1. `docker/setup-qemu-action` and `docker/setup-buildx-action`.
  2. For each of `amd64` and `arm64`: `docker buildx build --platform linux/$ARCH --load -t pinwall:ci-$ARCH --cache-from type=gha,scope=$ARCH --cache-to type=gha,mode=max,scope=$ARCH .`, then `pnpm image:size pinwall:ci-$ARCH`.
  3. The amd64 smoke test, which is M1's with `--cap-drop ALL --security-opt no-new-privileges` added.
  4. The arm64 smoke test, which must load the native SQLite module under emulation: `docker run --rm --platform linux/arm64 --read-only --tmpfs /tmp -v pw-arm64:/data pinwall:ci-arm64 migrate` exits 0 and logs `migrated`. `pinwall version` alone would not prove the binary loads.
  5. `docker run --rm --entrypoint sh pinwall:ci-amd64 -c 'test -s /app/THIRD_PARTY_NOTICES && grep -q "^hono " /app/THIRD_PARTY_NOTICES && ! command -v npm'`.
- [ ] **Step 5: Verify locally.**
  1. `docker buildx build --platform linux/amd64,linux/arm64 -t pinwall:multi .`. Expected: both platforms build (arm64 under emulation).
  2. The per-arch `--load` builds, `pnpm image:size` on each. Expected: under `200000000`, and the printed sizes go in the commit body.
  3. M1's read-only smoke on amd64, the arm64 `migrate` smoke from Step 4, and `docker run --rm --entrypoint id pinwall:ci-amd64 -u`. Expected: both smokes pass, and `10001`.
  4. `actionlint`. Expected: no findings.
- [ ] **Step 6: Commit** `build: build the image for amd64 and arm64 with notices and a size gate`.

### Task 9: Helm chart and Compose examples (model: sonnet)

**Files:**
- Create:
  - `deploy/helm/pinwall/{Chart.yaml,values.yaml,values.schema.json,README.md,.helmignore}`;
  - `deploy/helm/pinwall/templates/{_helpers.tpl,deployment.yaml,service.yaml,pvc.yaml,ingress.yaml,servicemonitor.yaml,networkpolicy.yaml,serviceaccount.yaml,NOTES.txt}`;
  - `deploy/helm/pinwall/ci/{default-values.yaml,full-values.yaml}`;
  - `deploy/compose/docker-compose.postgres-s3.yml`;
  - `tools/src/check-chart.ts`.
- Modify:
  - `deploy/compose/docker-compose.yml`: `image: ${PINWALL_IMAGE:-ghcr.io/dungnguyenv/pinwall:1.0.0}`, keeping `build:`; port `127.0.0.1:${PINWALL_PORT_PUBLISHED:-8080}:8080`; `PINWALL_PUBLIC_ORIGIN: ${PINWALL_PUBLIC_ORIGIN:-https://pinwall.example.com}`.
  - `.github/workflows/ci.yml`: job `chart`.
  - root `package.json`: `"chart:check": "pnpm --filter @pinwall/tools exec tsx src/check-chart.ts"`.

**Interfaces:**
- Consumes: Task 6 `CONFIG_VARS` (secret names); Task 8 image layout.
- Produces (`values.yaml` keys, each with a comment):
  - `image.{repository: ghcr.io/dungnguyenv/pinwall, digest: "", tag: "", pullPolicy: IfNotPresent}`, plus `imagePullSecrets: []`;
  - `publicOrigin: ""` (required);
  - `env: {}` (non-secret `PINWALL_*`);
  - `existingSecret: ""` and `secretFiles: {}` (env name → key, e.g. `PINWALL_SECRET_KEY: secret-key`);
  - `persistence.{enabled: true, existingClaim, storageClass, accessModes: [ReadWriteOnce], size: 10Gi, annotations}`;
  - `service.{type: ClusterIP, port: 80, annotations}`;
  - `ingress.{enabled: false, className, annotations, hosts: [], contentHost: "", tls: []}`;
  - `metrics.{enabled: true, port: 9464, serviceMonitor.{enabled: false, interval: 30s, labels}}`;
  - `networkPolicy.{enabled: false, ingressFrom: [], metricsFrom: [], restrictEgress: false, egress: []}`;
  - `resources` (requests cpu 100m / memory 256Mi, limit memory 1Gi);
  - `serviceAccount.{create: true, name, annotations}`;
  - `podAnnotations`, `podLabels`, `nodeSelector`, `tolerations`, `affinity`.

```ts
// tools/src/check-chart.ts — CLI, exit 1 with every failure listed; needs helm and kubeconform on PATH (clear error otherwise)
export function chartInvariants(docs: unknown[], o: { digest: string }): string[];
// runs: helm lint --strict with each ci/*.yaml; helm template per ci file → YAML docs (yaml.parseAllDocuments) → chartInvariants;
// kubeconform -strict -summary -kubernetes-version 1.31.0 -schema-location default
//   -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json';
// negative renders that must fail: no publicOrigin; publicOrigin 'https://x.example/path'; image.digest 'latest'; env.<each secret name> set inline
```

  Rules the templates follow, which `chartInvariants` checks on every render:
  - **Deployment shape.** `replicas: 1`, which `values.yaml` cannot change. `strategy.type: Recreate`. `automountServiceAccountToken: false`.
  - **Image.** `ghcr.io/dungnguyenv/pinwall@<digest>` when a digest is set. `repository:tag` only when the digest is empty and a tag is given. Neither → `fail "set image.digest (released charts carry it) or image.tag"`.
  - **Pod `securityContext`.** `runAsNonRoot: true`, `runAsUser: 10001`, `runAsGroup: 10001`, `fsGroup: 10001`, `fsGroupChangePolicy: OnRootMismatch`, `seccompProfile.type: RuntimeDefault`.
  - **Container `securityContext`.** `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `privileged: false`.
  - **Volumes.** `/data` from the PVC (an `emptyDir` with a NOTES warning when persistence is off), `/tmp` from an `emptyDir`. The secret is mounted at `/run/secrets/pinwall` with `defaultMode: 0440` and only the `secretFiles` keys.
  - **Env.**
    - `PINWALL_PUBLIC_ORIGIN`, plus `PINWALL_METRICS_PORT` (`0` when metrics are off).
    - `env:` entries.
    - `<NAME>_FILE=/run/secrets/pinwall/<key>` for each `secretFiles` entry.
    - A secret name in `env:` → `fail "set <NAME> through existingSecret and secretFiles, not env"`.
  - **Probes** on port `http`:
    - liveness `GET /healthz`;
    - readiness `GET /readyz`;
    - startup `GET /healthz` with `failureThreshold: 30`, `periodSeconds: 2`.

    `terminationGracePeriodSeconds: 15`.
  - **Ingress.** The host comes from `urlParse .Values.publicOrigin` unless `ingress.hosts` is set. A non-empty `ingress.contentHost` (e.g. `*.pinwall-content.example`) adds a rule for content-domain mode.
  - **ServiceMonitor** targets port `metrics`, path `/metrics`.
  - **NetworkPolicy.**
    - Ingress: port `http` from `ingressFrom` (everyone when it is empty); port `metrics` from `metricsFrom` only.
    - Egress is open unless `restrictEgress`. With `restrictEgress`, DNS (53 UDP/TCP) and `egress` only.

  `values.schema.json` requires:
  - `publicOrigin` matching `^https?://[^/]+$`;
  - `image.digest` matching `^(sha256:[0-9a-f]{64})?$`.

  `ci/full-values.yaml` turns everything on: the ingress with `contentHost`, the ServiceMonitor, the NetworkPolicy with `restrictEgress`, `existingSecret` with five `secretFiles`, and an `env` with Postgres-, S3- and content-domain-shaped values.

  Compose `docker-compose.postgres-s3.yml`:
  - **Services:**
    - `postgres` (`postgres:17-alpine`, `POSTGRES_PASSWORD_FILE`, volume, `pg_isready` healthcheck);
    - `minio` (pinned to the newest `minio/minio:RELEASE.*` tag, `MINIO_ROOT_USER_FILE`/`MINIO_ROOT_PASSWORD_FILE`, volume, `mc ready local`);
    - `minio-init` (bucket `pinwall`);
    - `pinwall` (`${PINWALL_IMAGE:-…}`, `depends_on` healthy).
  - **Pinwall env:**
    - `PINWALL_DATABASE_URL_FILE`, `PINWALL_SECRET_KEY_FILE`, `PINWALL_S3_ACCESS_KEY_ID_FILE`, `PINWALL_S3_SECRET_ACCESS_KEY_FILE`;
    - `PINWALL_STORAGE=s3`, `PINWALL_S3_BUCKET=pinwall`, `PINWALL_S3_ENDPOINT=http://minio:9000`, `PINWALL_S3_FORCE_PATH_STYLE=true`.
  - **Hardening and storage:** `read_only`, `tmpfs /tmp`, `cap_drop ALL`, `no-new-privileges`, `pinwall-data:/data` for the spool.
  - **Secrets** come from `${PINWALL_SECRETS_DIR:-./secrets}/<name>`.
  - **The header comment** gives the exact `openssl rand` commands that create the five files (the database URL is built from the same password). It also says any S3-compatible store works, and that production should use a dedicated access key.
- [ ] **Step 1: Write `check-chart.ts`** and its unit test `tools/test/check-chart.test.ts`. `chartInvariants` over a hand-written Deployment missing `readOnlyRootFilesystem` → one problem naming it; over a good one → `[]`.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/check-chart && pnpm chart:check`. Expected: the unit test passes; `chart:check` fails because there is no chart yet.
- [ ] **Step 3: Write** the chart, the compose file and the CI job `chart`. The job runs `azure/setup-helm` (version `v4.3.1`), then installs kubeconform `v0.8.0` from its GitHub release tarball, verified against the release's `CHECKSUMS`. Then `pnpm install --frozen-lockfile` and `pnpm chart:check`.
- [ ] **Step 4: Verify** (with `brew install helm kubeconform` if missing).
  - `pnpm chart:check`. Expected: lint clean, kubeconform `Invalid: 0, Errors: 0`, no invariant failures, every negative render failing with its message.
  - Then, with a temp secrets dir:

    ```bash
    PINWALL_SECRETS_DIR=<dir> docker compose -f deploy/compose/docker-compose.postgres-s3.yml config -q
    PINWALL_IMAGE=pinwall:ci-amd64 PINWALL_PUBLIC_ORIGIN=http://localhost:8080 PINWALL_SECRETS_DIR=<dir> \
      docker compose -p pinwall-check -f deploy/compose/docker-compose.postgres-s3.yml up -d --wait
    curl -fsS localhost:8080/readyz
    docker compose -p pinwall-check -f deploy/compose/docker-compose.postgres-s3.yml down -v
    ```

    Expected: `{"status":"ok",…}`.
  - Finally `actionlint`. Expected: no findings.
- [ ] **Step 5: Commit** `feat(deploy): add a hardened Helm chart and a Postgres + S3 Compose example`.

### Task 10: User and project documentation (model: sonnet)

**Files:**
- Create: `docs/authoring.md`, `deploy/helm/pinwall/README.md` (values reference, replacing the Task 9 stub), `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `tools/test/docs.test.ts`
- Modify: `README.md` (rewrite)

**Interfaces:**
- Consumes: Task 6 `CONFIG_VARS`; M6 `docs/connect-an-agent.md`; Tasks 1–9 behavior.
- Produces: `CHANGELOG.md` with a `## 1.0.0` section (Task 11's release notes read it).

  Every doc is original writing, with `https://pinwall.example` as the placeholder origin. Required contents:
  - **README.md:**
    1. What Pinwall is, in two short paragraphs.
    2. **Quick start:**
       - the exact command `docker run -v pinwall:/data -p 8080:8080 ghcr.io/dungnguyenv/pinwall`, then how to find the setup link: `docker logs <name> 2>&1 | grep setup_url`. The link is valid for 24 hours, and a restart prints a new one;
       - setting `PINWALL_PUBLIC_ORIGIN` behind a proxy;
       - links to `docs/configuration.md` and `deploy/compose/`.
    3. **Connect an agent:** `claude mcp add --transport http pinwall https://pinwall.example/mcp`, plus a link to `docs/connect-an-agent.md`.
    4. **Content isolation:** both modes and their trade-off in plain words; what each needs (nothing, or a second domain with a wildcard certificate); `PINWALL_ISOLATION` and `PINWALL_CONTENT_ORIGIN`; and that switching keeps every link working after a restart.
    5. **Sign-in:** the owner account, plus OIDC recipes. Each recipe gives exact env lines and the redirect URI `https://pinwall.example/auth/oidc/callback`.
       - **Zitadel:** project roles `pinwall-admin`/`pinwall-member` with "Assert Roles on Authentication"; a Web app using the code flow with a refresh token; `PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles`.
       - **Keycloak:** a confidential client with PKCE S256, and a group-membership mapper named `groups` with full path off; `PINWALL_OIDC_ROLES_CLAIM=groups`. Note that CI tests this setup.
       - **Google:** `PINWALL_OIDC_ISSUER=https://accounts.google.com`, `PINWALL_OIDC_SCOPES=openid email profile` (Google refuses `offline_access`), and `PINWALL_OIDC_EXTRA_AUTH_PARAMS=access_type=offline&prompt=consent`; roles from `PINWALL_ADMIN_EMAILS`, `PINWALL_MEMBER_DOMAINS` and `PINWALL_MEMBER_EMAILS`.
    6. **Behind a proxy or Cloudflare Tunnel:**
       - `PINWALL_PUBLIC_ORIGIN` and `PINWALL_TRUST_PROXY=true` for one hop;
       - content responses carry `Cache-Control: no-transform`, which keeps Cloudflare from rewriting pages, so no Transform Rule or Worker should remove it;
       - keep Rocket Loader off, since the app's CSP blocks its script;
       - the 100 MB request cap on Free and Pro against the 95 MB default;
       - SSE heartbeats every 25 s;
       - content-domain mode on Cloudflare: a separate zone with a one-level wildcard `*.pinwall-content.example`, which Universal SSL covers.
    7. **Kubernetes:** `helm install pinwall oci://ghcr.io/dungnguyenv/charts/pinwall --version 1.0.0 --set publicOrigin=https://pinwall.example`, plus the `existingSecret`/`secretFiles` example.
    8. **Backup and restore:**
       - `docker exec pinwall pinwall backup --out - > pinwall-$(date +%F).tar`, with the warning never to use `-t`;
       - restore into an empty install with `docker exec -i <new> pinwall restore --in - < pinwall.tar`, and the `kubectl exec -i deploy/pinwall --` form;
       - what the archive holds, and that it is as sensitive as the database;
       - deleted content lives on in older backups;
       - the secret key: back it up separately.
    9. **Upgrade from SQLite + local disk to Postgres + S3:**
       1. Back up.
       2. Read the old key as hex: `docker exec pinwall od -An -tx1 -v /data/secret.key | tr -d ' \n' > secret_key`.
       3. Start the Postgres + S3 stack with `PINWALL_SECRET_KEY_FILE` pointing at that file.
       4. Restore, check, then switch DNS.

       Without the old key, SSO users sign in again (the restore warning).
    10. Metrics on port 9464; the security summary with links to `SECURITY.md` and `CONTRIBUTING.md`; license Apache-2.0 and `THIRD_PARTY_NOTICES`.
  - **docs/authoring.md:**
    - the entry page rules;
    - relative links, with absolute `/x` links breaking under a grant base, and the publish warnings that name them;
    - nested frames of the artifact's own pages;
    - `#anchors`;
    - opaque-origin consequences in single-domain mode (no cookies, `localStorage`, `sessionStorage`, IndexedDB or service workers; keep state in memory or the URL), and per-version origins in content-domain mode;
    - the page's own CSP is respected, and a CSP blocking the annotator still allows point comments;
    - size and file limits by env name;
    - Markdown features.
  - **SECURITY.md:**
    - report privately through GitHub's private vulnerability reporting on `dungnguyenv/pinwall`, never in public issues;
    - supported versions (the latest minor);
    - a short summary of the security model (capability tokens, the sandbox CSP, CSRF origin check, hashed secrets, no telemetry);
    - verifying a release, with commands `cosign verify ghcr.io/dungnguyenv/pinwall@sha256:<digest> --certificate-identity-regexp '^https://github.com/dungnguyenv/pinwall/\.github/workflows/release\.yml@refs/tags/v' --certificate-oidc-issuer https://token.actions.githubusercontent.com` and `gh attestation verify oci://ghcr.io/dungnguyenv/pinwall@sha256:<digest> --repo dungnguyenv/pinwall`.
  - **CONTRIBUTING.md:**
    - setup (Node 24, `corepack enable`, `pnpm install`);
    - the test commands (`pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:acceptance`);
    - Conventional Commits;
    - original work only;
    - the license check and allowed licenses;
    - `pnpm docs:config` after a config change;
    - contributions are accepted under Apache-2.0.
  - **CHANGELOG.md:** a one-line intro, then `## 1.0.0` with an `### Added` list of the v1 capabilities in original wording.
- [ ] **Step 1: Write the failing test** `tools/test/docs.test.ts`. Over `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/*.md` and `deploy/helm/pinwall/README.md`:
  - every relative Markdown link resolves to a file;
  - every same-file `#anchor` matches a heading slug;
  - every `PINWALL_[A-Z0-9_]+` token is a `CONFIG_VARS` name, or one plus `_FILE`;
  - README contains `docker run -v pinwall:/data -p 8080:8080 ghcr.io/dungnguyenv/pinwall` and `claude mcp add --transport http pinwall`;
  - `CHANGELOG.md` has a `## 1.0.0` heading.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/docs`. Expected: FAIL.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run** the Step 2 command and `pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: add README, authoring guide, security policy, contributing guide and changelog`.

### Task 11: Release workflow, reusable CI and version 1.0.0 (model: opus)

**Files:**
- Create: `.github/workflows/release.yml`, `tools/src/release.ts`, `tools/test/release.test.ts`
- Modify:
  - `.github/workflows/ci.yml`: add `workflow_call:` to `on`, and a job `workflows` that runs actionlint;
  - version `1.0.0` in the root `package.json`, every `apps/*`, `packages/*` and `tools` `package.json`, and in `deploy/helm/pinwall/Chart.yaml` (`version` and `appVersion`).

**Interfaces:**
- Consumes: Task 7 (notices in the image), Task 8 (Dockerfile build args), Task 9 (chart), Task 10 (`CHANGELOG.md`).
- Produces:

```ts
export function releaseVersion(tag: string): string;   // 'v1.0.0' → '1.0.0', 'v1.1.0-rc.1' → '1.1.0-rc.1'; anything else throws
export function checkVersions(root: string, version: string): string[];   // each package.json and Chart.yaml version/appVersion that differs
export function releaseNotes(changelog: string, version: string, p: { digest: string }): string;
  // the body under `## <version>` up to the next `## ` (missing or empty → throws) + an 'Image' section with `ghcr.io/dungnguyenv/pinwall@<digest>`,
  // the helm install command and the cosign / gh attestation verify commands from SECURITY.md
export function setChartRelease(chartDir: string, p: { version: string; digest: string }): void;   // values.yaml image.digest, Chart.yaml version/appVersion; comments kept (yaml Document API)
// CLI: tsx src/release.ts check <tag> | notes <tag> <digest> --out <file> | chart <tag> <digest>
```

  Action pins as of 2026-11-10. Re-check each with `gh api repos/<repo>/commits/<tag> --jq .sha` before committing, and keep the CI job's existing pins:

  | Action | Version | SHA |
  | --- | --- | --- |
  | `docker/setup-qemu-action` | v4.4.0 | `99012661954931238ded8c8b007157a8430204e1` |
  | `docker/setup-buildx-action` | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
  | `docker/login-action` | v4.8.0 | `8aa5831fb8d48d8f76594c7ddde61ae58019f550` |
  | `docker/build-push-action` | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |
  | `sigstore/cosign-installer` | v4.1.3 | `756fe2d284c7292c4e9b62c8a28f1e5629c59532` |
  | `actions/attest-build-provenance` | v4.2.2 | `4d101475d8b20a2381f78447822ac1eab6504dd8` |
  | `actions/attest-sbom` | v4.1.0 | `c604332985a26aa8cf1bdc465b92731239ec6b9e` |
  | `anchore/sbom-action` | v0.24.3 | `66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c` |
  | `azure/setup-helm` | v5.1.0 | `2f5e7bc67f1f9972ab16657bb795f36d8f04de0e` |
  | `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
  | `actions/download-artifact` | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |

  `release.yml`: `on: push: tags: ['v*']`, top-level `permissions: {}`, `concurrency: release-${{ github.ref }}` (no cancel). Jobs:
  1. **`verify`** (`contents: read`): checkout, pnpm and node, `pnpm install --frozen-lockfile`, then `tsx src/release.ts check "$TAG"`, with `TAG: ${{ github.ref_name }}` passed through `env:`.
  2. **`test`** (needs `verify`): `uses: ./.github/workflows/ci.yml`, with `permissions: contents: read`.
  3. **`image`** (needs `test`; `contents: read`, `packages: write`, `id-token: write`, `attestations: write`):
     1. QEMU, Buildx, then `docker/login-action` to `ghcr.io` with `${{ github.actor }}` and `GITHUB_TOKEN`.
     2. `build-push-action`:
        - `platforms: linux/amd64,linux/arm64`, `push: true`, `provenance: false`, `sbom: false`;
        - build args `PINWALL_VERSION` and `PINWALL_REVISION=${{ github.sha }}`;
        - tags `<version>`, `<major>.<minor>` and `<major>`, plus `latest` only when the version has no `-`.
     3. `cosign sign --yes "ghcr.io/dungnguyenv/pinwall@$DIGEST"`.
     4. `attest-build-provenance` (`subject-name: ghcr.io/dungnguyenv/pinwall`, `subject-digest`, `push-to-registry: true`).
     5. `anchore/sbom-action` on `…@$DIGEST`, `format: spdx-json`, `output-file: pinwall-<version>.spdx.json`, no uploads, then `attest-sbom` with `push-to-registry: true`.
     6. Copy `/app/THIRD_PARTY_NOTICES` out with `docker create` + `docker cp`.
     7. Upload both files as an artifact, and output `digest`.
  4. **`chart`** (needs `image`; same permissions as `image`):
     1. `setup-helm`.
     2. `tsx src/release.ts chart "$TAG" "$DIGEST"`.
     3. `helm package deploy/helm/pinwall -d dist`.
     4. `helm registry login ghcr.io --username "$ACTOR" --password-stdin`.
     5. `helm push dist/pinwall-<version>.tgz oci://ghcr.io/dungnguyenv/charts`, parsing `Digest:` from its output.
     6. `cosign sign --yes ghcr.io/dungnguyenv/charts/pinwall@<chart digest>`.
     7. `attest-build-provenance` with `subject-path` = the tgz.
     8. Upload the tgz.
  5. **`release`** (needs `image` and `chart`; `contents: write`):
     1. Download the artifacts.
     2. `tsx src/release.ts notes "$TAG" "$DIGEST" --out notes.md`.
     3. `gh release create "$TAG" --verify-tag --title "Pinwall $VERSION" --notes-file notes.md` (add `--prerelease` when the version has `-`), attaching the chart tgz, the SBOM and `THIRD_PARTY_NOTICES`. `GH_TOKEN` comes from `GITHUB_TOKEN`.

  The `workflows` job in `ci.yml` runs `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint@<digest of 1.7.12> -color`.
- [ ] **Step 1: Write the failing tests:**
  - `releaseVersion`: valid tags, plus `'1.0.0'`, `'v1'` and `'vx'` throw.
  - `checkVersions` over a temp tree where one `package.json` says `0.9.0` → one problem naming it.
  - `releaseNotes` over a fixture changelog: picks `## 1.0.0` and stops at `## 0.9.0`; a missing version throws; the digest and both verify commands appear.
  - `setChartRelease` on a copy of the chart: digest and versions set, and the comment above `digest:` kept.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/release`. Expected: FAIL.
- [ ] **Step 3: Implement** `release.ts`, the workflows, and the version bump.
- [ ] **Step 4: Verify without publishing.**
  - `actionlint`. Expected: no findings.
  - `pnpm --filter @pinwall/tools exec tsx src/release.ts check v1.0.0`. Expected: no problems.
  - `… notes v1.0.0 sha256:$(printf 0%.0s {1..64}) --out /tmp/notes.md`. Expected: the changelog section plus the image section.
  - In a scratch copy of the chart: `… chart v1.0.0 sha256:<64 hex>`, then `helm package`. Expected: `pinwall-1.0.0.tgz`, whose `helm show values` has the digest.
  - `docker buildx build --platform linux/amd64,linux/arm64 --build-arg PINWALL_VERSION=1.0.0 .` (no push). Expected: success.
  - `pnpm build && node apps/server/dist/main.mjs version`. Expected: `1.0.0`.
- [ ] **Step 5: Commit** `ci: add the signed multi-arch release workflow and set version 1.0.0`.

### Task 12: Keycloak end-to-end sign-in (model: sonnet)

**Files:**
- Create: `e2e/keycloak/{keycloak.config.ts,realm.json,global-setup.ts,global-teardown.ts,sign-in.spec.ts}`
- Modify: root `package.json` (`"test:e2e:keycloak": "pnpm --filter @pinwall/web build && playwright test -c e2e/keycloak/keycloak.config.ts"`), `.github/workflows/ci.yml` (job `e2e`)

**Interfaces:**
- Consumes: M7b `startPinwall({ port, publicOrigin?, env? })`, the sign-in page's OIDC button label (`Sign in with <PINWALL_OIDC_DISPLAY_NAME>`, as M7a renders it); M3 no-access copy `oidc.noAccess.title`, `oidc.noAccess.switch`.
- Produces: no exports.

  **`realm.json`** (test fixture; its secret is test-only):
  - Realm `pinwall`, `sslRequired: none`.
  - Groups `pinwall-admins` and `pinwall-members`.
  - Client `pinwall`:
    - confidential, `secret: pinwall-e2e-client-secret`;
    - `redirectUris: ["http://localhost:18096/auth/oidc/callback"]`;
    - `standardFlowEnabled: true`, `directAccessGrantsEnabled: false`, `consentRequired: false`;
    - attribute `pkce.code.challenge.method: S256`;
    - protocol mapper `oidc-group-membership-mapper`: claim `groups`, `full.path: false`, in the ID token, access token and userinfo;
    - `offline_access` among the optional scopes.
  - Users, each with first and last name, `emailVerified: true` and a non-temporary password:
    - `ada` / `ada-e2e-password` in `pinwall-admins`;
    - `bob` / `bob-e2e-password` in `pinwall-members`;
    - `eve` / `eve-e2e-password` (Eve Example, `eve@example.test`) in no group.

  **Global setup:**
  1. `docker run -d --name pinwall-e2e-keycloak -p 127.0.0.1:18180:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=<random> -v <abs e2e/keycloak>/realm.json:/opt/keycloak/data/import/pinwall.json:ro quay.io/keycloak/keycloak:26.8.2 start-dev --import-realm`.
  2. Poll `http://localhost:18180/realms/pinwall/.well-known/openid-configuration` for up to 180 s.
  3. Then `startPinwall({ port: 18096, env })` with `PINWALL_OIDC_ISSUER=http://localhost:18180/realms/pinwall`, `PINWALL_OIDC_CLIENT_ID=pinwall`, `PINWALL_OIDC_CLIENT_SECRET=pinwall-e2e-client-secret`, `PINWALL_OIDC_DISPLAY_NAME=Keycloak`, `PINWALL_OIDC_ROLES_CLAIM=groups`, `PINWALL_OIDC_ADMIN_GROUPS=pinwall-admins`, `PINWALL_OIDC_MEMBER_GROUPS=pinwall-members`.

  Teardown always runs `docker rm -f pinwall-e2e-keycloak` and stops Pinwall.
- [ ] **Step 1: Write the spec.** Each test gets a fresh browser context.
  - `keycloakLogin(page, user, pw)` fills `#username` and `#password` and clicks `#kc-login`.
  - `acceptConsentIfShown(page)` clicks Keycloak's consent `Yes` button when it appears within 3 s.

```ts
test('an admin from pinwall-admins signs in as admin', async ({ page }) => {
  await page.goto('/signin'); await page.getByRole('button', { name: 'Sign in with Keycloak' }).click();
  await keycloakLogin(page, 'ada', 'ada-e2e-password'); await acceptConsentIfShown(page);
  await expect(page).toHaveURL(/^http:\/\/localhost:18096\//);
  expect(await page.evaluate(() => fetch('/api/v1/me').then((r) => r.json()))).toMatchObject({ kind: 'oidc', role: 'admin', email: 'ada@example.test' });
  await page.goto('/admin/users'); // the users table (M7b) lists Ada
});
test('a member from pinwall-members signs in as member', ...);   // bob → role 'member'; /admin/users shows M7b's admin-only state
test('an unadmitted user sees who signed in and can switch accounts', async ({ page }) => {
  // eve → status page with heading t('oidc.noAccess.title'), text 'Eve Example' and 'eve@example.test', link t('oidc.noAccess.switch')
  // click it → Keycloak's login form is shown again (#username visible) → keycloakLogin bob → back on Pinwall, /api/v1/me role 'member'
});
```

- [ ] **Step 2: Run** `pnpm exec playwright install chromium && pnpm test:e2e:keycloak`. Expected: FAIL until the support files exist. If Keycloak does not show its login form after "Use a different account", that is a product defect in M3's prompt handling: report it, do not weaken the test.
- [ ] **Step 3: Implement** the config (Chromium only, `workers: 1`, `baseURL http://localhost:18096`), the setup and the teardown. The CI job `e2e` runs:
  1. `pnpm install --frozen-lockfile` and `pnpm exec playwright install --with-deps chromium`;
  2. `pnpm test:e2e`, which includes M8b's review suite;
  3. `pnpm --filter @pinwall/server test:e2e:annotator`;
  4. `pnpm test:e2e:keycloak`.

  It uploads the Playwright reports on failure.
- [ ] **Step 4: Run** `pnpm test:e2e:keycloak`, then `actionlint`. Expected: `3 passed`; no findings.
- [ ] **Step 5: Commit** `test(e2e): sign in through a real Keycloak with groups mapped to roles`.

### Task 13: Acceptance suite and manual checklist (model: opus)

**Files:**
- Create:
  - `e2e/acceptance.config.ts`, `e2e/acceptance/{install.spec.ts,backup-restore.spec.ts}`;
  - `e2e/support/{docker.ts,node-api.ts}`;
  - `tools/src/acceptance.ts`, `tools/test/acceptance.test.ts`;
  - `docs/acceptance.md`.
- Modify: root `package.json` (`"test:acceptance": "pnpm --filter @pinwall/web build && pnpm --filter @pinwall/tools exec tsx src/acceptance.ts"`), `.github/workflows/ci.yml` (job `acceptance`, `timeout-minutes: 45`)

**Interfaces:**
- Consumes: Tasks 1–12; M7b web labels (setup page, sign-in, upload, `All artifacts` heading); M4b/M5 REST routes; the M6 `agent-flow`, M3 `flow`, M5 `review-flow` and M4b `publishing-flow` suites; M8b `test:e2e:review`.
- Produces:

```ts
// e2e/support/docker.ts
export interface Container { name: string; origin: string; logs(): Promise<string>; exec(args: string[], o?: { stdin?: Buffer }): Promise<{ code: number; stdout: Buffer; stderr: string }>; stop(): Promise<void> }
export function runImage(o: { image: string; name: string; volume: string; port: number; env?: Record<string, string> }): Promise<Container>;
  // `docker run -d --name <name> -v <volume>:/data -p <port>:8080 [-e …] <image>`; adds PINWALL_PUBLIC_ORIGIN only when port !== 8080
export function waitForSetupUrl(c: Container, timeoutMs: number): Promise<string>;   // the setup_url field of the JSON log line
export function composeUp(o: { file: string; project: string; env: Record<string, string> }): Promise<{ exec: Container['exec']; down(): Promise<void> }>;
// e2e/support/node-api.ts — Node fetch against http://localhost:<port> (only *.localhost hosts need a browser)
export interface Api { cookie: string; call<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: T; headers: Headers }> }
export function setupAndSignIn(origin: string, setupUrl: string, password: string): Promise<Api>;
export function signIn(origin: string, password: string): Promise<Api>;
export function publishSite(api: Api, files: Record<string, string | Buffer>, target?: object): Promise<{ artifact_id: string; version_id: string; version_number: number }>;
  // publish session → tar.gz written with the system `tar -czf` → POST to the upload URL
// tools/src/acceptance.ts
export interface AcceptanceItem { id: '1' | '2' | '3' | '3a' | '3b' | '4' | '5' | '6' | '7' | '8' | '9' | '10'; title: string;
  automated: { label: string; command: string[] }[]; manual: string | null /* heading slug in docs/acceptance.md */ }
export const ITEMS: readonly AcceptanceItem[];
export function renderReport(results: Map<string, 'pass' | 'fail'>): string;   // Markdown table: Item | Automated by | Result | Manual check
```

  `ITEMS` (commands run from the repo root, each identical command once):
  - **Image build:** `docker build -t pinwall:acceptance .`. Skipped when `PINWALL_ACCEPTANCE_IMAGE` names a built image.
  - **1, 6, 7, 9, 10** → `pnpm exec playwright test -c e2e/acceptance.config.ts`.
  - **2, 3a, 4 (agent side)** → `pnpm --filter @pinwall/server exec vitest run test/mcp/agent-flow`. Manual: `claude-code`, `claude-desktop`.
  - **3, 3b** → `pnpm --filter @pinwall/server exec vitest run test/auth/oidc/flow` and `pnpm test:e2e:keycloak`. Manual: `zitadel`, `google`.
  - **4 (browser), 5** → `pnpm test:e2e:review`. Manual: `review-loop`.
  - **8 (server side)** → `pnpm --filter @pinwall/server exec vitest run test/api/review-flow test/api/publishing-flow`. Manual: `cloudflare-tunnel`.

  The runner prints `renderReport`, writes it to `e2e/acceptance-report.md` (gitignored), and exits 1 when any command fails.
- [ ] **Step 1: Write the failing runner test** `tools/test/acceptance.test.ts`:
  - `ITEMS.map(i => i.id)` equals the twelve spec ids in order.
  - Every `manual` slug is a heading in `docs/acceptance.md`.
  - Every test path named in a command exists on disk.
  - Every item has at least one automated command.
- [ ] **Step 2: Write `install.spec.ts`.** It is serial and uses the image from `PINWALL_ACCEPTANCE_IMAGE` (default `pinwall:acceptance`), port `PINWALL_ACCEPTANCE_PORT` (default `8080`, which is exactly the spec's command) and a fresh volume `pinwall-acc-<random>`.

```ts
test('1: docker run and the setup link give a working install in under five minutes', async ({ page }, info) => {
  const started = Date.now();
  const c = await runImage({ image, name: `pinwall-acc-${id}`, volume, port });
  const setupUrl = await waitForSetupUrl(c, 120_000);
  expect(setupUrl).toMatch(new RegExp(`^http://localhost:${port}/setup\\?token=`));
  await page.goto(setupUrl);   // fill name 'Ada' + password and confirm 'correct horse battery staple' with M7b's labels, submit
  await expect(page.getByRole('heading', { name: 'All artifacts' })).toBeVisible();
  // 'Upload' → file input ← index.html '<h1>Hello acceptance</h1>' → toast 'Published' → open it → the review frame shows 'Hello acceptance'
  const elapsed = Date.now() - started;
  info.annotations.push({ type: 'elapsed', description: `${Math.round(elapsed / 1000)} s (image already pulled)` });
  expect(elapsed).toBeLessThan(300_000);
});
test('7: "chup anh" finds the artifact containing "chụp ảnh"', ...);
  // signIn → publishSite({ 'index.html': '<h1>Dịch vụ chụp ảnh</h1>' }) → GET /api/v1/artifacts?q=chup%20anh → items contain it
test('9: deleting a version with a secret makes its links gone and removes its files', ...);
  // v1 { index.html, 'secret.txt': `sk-live-${random}`, 'shared.css' }, v2 { index.html, 'shared.css' };
  // grant = location of GET /a/:id/v/1/raw; DELETE /api/v1/artifacts/:id/versions/1 → 204;
  // /a/:id/v/1/raw → 410 and GET <grant>secret.txt → 410 at once;
  // c.exec(['sh', '-c', `test ! -e /data/blobs/${s.slice(0,2)}/${s.slice(2,4)}/${s}`]) → 0 for the secret's sha; the same test without '!' → 0 for shared.css
test('10: switching the isolation mode and restarting keeps every link working', async ({ page }) => {
  // record /a/:id, /a/:id/raw, /a/:id/v/2/raw and a public share link /s/<token> with their published bytes; c.stop();
  // runImage on the same volume with PINWALL_ISOLATION=content-domain, PINWALL_CONTENT_ORIGIN=http://pwc.localhost:<port>;
  // sign in in the browser; each raw and share link (page.goto) → final URL host ends '.pwc.localhost:<port>', body equals the bytes;
  // /a/:id shows the review frame from the content host; restart again in single-domain → the same links end under /c/ with the same bytes
});
```

- [ ] **Step 3: Write `backup-restore.spec.ts`** (acceptance 6).
  1. **Source A** is `runImage` with SQLite and local disk, set up by `setupAndSignIn`. Publish v1 and v2 of a site with `img/photo.png` (binary) and Vietnamese text. Add a thread with a reply on v1 (`POST /api/v1/artifacts/:id/comments`, `POST /api/v1/comments/:id/replies`), resolve it in v2, create a password share link, and create an API token.
  2. `A.exec(['pinwall', 'backup', '--out', '-'])`. Expected: exit 0; the stdout bytes start a tar whose first entry is `manifest.json`.
  3. **Target B** is `composeUp` of `deploy/compose/docker-compose.postgres-s3.yml`, with project `pinwall-acc-b-<random>`, `PINWALL_IMAGE`, `PINWALL_PORT_PUBLISHED=18120`, `PINWALL_PUBLIC_ORIGIN=http://localhost:18120`, and a temp `PINWALL_SECRETS_DIR` of freshly generated secrets.
  4. `B.exec(['pinwall', 'restore', '--in', '-'], { stdin })`. Expected: exit 0, and stderr has `restore complete`.
  5. On B:
     - the owner signs in with the same password, and A's API token works on `GET /api/v1/me`;
     - artifact names, version numbers and tags equal A's;
     - every file of v2 fetched through `/a/:id/v/2/raw` equals A's bytes (sha256);
     - `q=chup anh` finds it;
     - the thread and reply are on v1 with `resolved_in_version_number: 2` (or M5's equivalent field);
     - the share link needs the password and then serves the page.
  6. A second restore into B. Expected: exit 1, stderr `Restore failed: The target is not empty`.
  7. Teardown removes A, its volume, and B with `down -v`.
- [ ] **Step 4: Write `docs/acceptance.md`.** It opens with a results table (item, date, Pinwall version or digest, who, pass/fail). Then one `##` section per manual check, each with exact steps and the expected result:
  - **`claude-code`:** acceptance 2 with the real CLI. Run the image, `claude mcp add --transport http pinwall http://localhost:8080/mcp`, `/mcp` → Authenticate, "publish ./site to Pinwall". Expected: a review link within a minute, no token pasted, no CLI installed.
  - **`review-loop`:** acceptance 4 with the real Claude Code. Pin a comment on v1 in the browser, ask "read the comments and fix", and watch the open tab. Expected: it switches to v2, and the comment shows "Resolved in v2".
  - **`zitadel`:** a real Zitadel instance with project roles `pinwall-admin`/`pinwall-member` and the README's env lines. Expected: an admin, a member and an unadmitted user behave as specified, and "Use a different account" lets you choose again.
  - **`google`:** a real Google OAuth client with the README's env lines. Expected: a listed admin email → admin, a listed domain → member, a personal Gmail in `PINWALL_MEMBER_EMAILS` → member, an unlisted Gmail → the no-access page.
  - **`claude-desktop`:** acceptance 3a.
    1. Start `cloudflared tunnel --url http://localhost:8080` and note the `https://<name>.trycloudflare.com` origin.
    2. Restart Pinwall with that `PINWALL_PUBLIC_ORIGIN` and `PINWALL_TRUST_PROXY=true`.
    3. In Claude Desktop, Settings → Connectors → Add custom connector with `<origin>/mcp`, then sign in.
    4. Ask it to publish a one-file HTML page.

    Expected: the inline tool is used and the review link opens.
  - **`cloudflare-tunnel`:** acceptance 8, over the same tunnel.
    1. Publish a fixture folder with an HTML page containing an email address, inline `<script>`, extra whitespace, `app.js` and an image.
    2. For the raw link and a public share link: `curl -sSL --compressed <origin>/a/<id>/v/1/raw…` per file, and the same through `/s/<token>`.
    3. Compare `shasum -a 256` with the local files.

    Expected: identical hashes, and `cache-control` containing `no-transform` on every content response (`curl -sI`).
  - **`two-machines`** (optional, for 6): the README backup and restore commands between two hosts.

  It also notes that acceptance 1's automated time excludes the image pull, and asks the manual run to time a fresh `docker run` including the pull.
- [ ] **Step 5: Run** `pnpm --filter @pinwall/tools test test/acceptance`. Expected: PASS. Then `pnpm test:acceptance`. Expected: every automated line `pass`, and the report table printed. Paste the table in the commit body. Fix failures only in the task or milestone that owns the behavior.
- [ ] **Step 6: Add the CI job `acceptance`:**
  1. Checkout, pnpm and node, then `pnpm install --frozen-lockfile`.
  2. `pnpm exec playwright install --with-deps chromium`.
  3. Bring up the test stack with `docker compose -f docker-compose.test.yml up -d --wait` and set the `PINWALL_TEST_*` env, so the M3/M6 suites also run on Postgres.
  4. Build the image with Buildx and GHA cache (`--load -t pinwall:acceptance`).
  5. `PINWALL_ACCEPTANCE_IMAGE=pinwall:acceptance pnpm test:acceptance`.
  6. Upload `e2e/acceptance-report.md` with `if: always()`.

  Then run `actionlint`. Expected: no findings.
- [ ] **Step 7: Commit** `test: add the v1 acceptance suite and the manual acceptance checklist`.

---

## M9 done when (M9a and M9b together)

- Everything in "M9a done when" holds.
- `pnpm lint && pnpm typecheck && pnpm test` pass, including the `tools` tests.
- `pnpm licenses:check` and `pnpm chart:check` pass. `actionlint` reports nothing.
- Both platform images build locally. Each is under 200 MB compressed, ships `THIRD_PARTY_NOTICES`, and migrates a database (arm64 under emulation).
- `pnpm test:e2e`, `pnpm test:e2e:keycloak` and `pnpm test:acceptance` pass. The acceptance report shows every automated item as `pass`.
- `docs/acceptance.md` lists each manual check with exact steps. The controller runs them against the built image and records the results there. With that, every spec §9 item is either automated and passing or proven by a recorded manual check.
- Nothing has been pushed, tagged or released.
