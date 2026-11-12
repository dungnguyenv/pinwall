/*
 * The Helm chart check. It lints the chart, renders it for every values file in
 * deploy/helm/pinwall/ci, validates what comes out against the Kubernetes schemas, and checks the
 * rules a hardened install depends on (the invariants below) on every render. It also tries the
 * renders that must be refused, and fails when one of them succeeds.
 *
 *   tsx src/check-chart.ts
 *
 * Needs `helm` and `kubeconform` on PATH. Every problem is listed; the exit code is 1 when there
 * is any.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import { CONFIG_VARS } from '../../apps/server/src/config/catalog.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const CHART_DIR = join(ROOT, 'deploy/helm/pinwall');

/** The variables that hold secrets: they may only reach the pod as `<NAME>_FILE`. */
export const SECRET_NAMES: readonly string[] = CONFIG_VARS.filter((v) => v.secret).map(
  (v) => v.name,
);

const REPOSITORY = 'ghcr.io/dungnguyenv/pinwall';
const SECRETS_DIR = '/run/secrets/pinwall';
const KUBERNETES_VERSION = '1.31.0';
const CRD_SCHEMAS =
  'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `value.a.b.c` for `at(value, 'a', 'b', 'c')`, or undefined when any step is missing. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObj(current)) return undefined;
    current = current[key];
  }
  return current;
}

const text = (value: unknown): string => String(value ?? '');

/** Whether every label of `wanted` is in `labels`. */
function covers(labels: unknown, wanted: unknown): boolean {
  if (!isObj(labels) || !isObj(wanted)) return false;
  return Object.entries(wanted).every(([key, value]) => labels[key] === value);
}

/** What a restricted Pod Security profile and this chart require of the pod. */
const POD_SECURITY: Record<string, unknown> = {
  runAsNonRoot: true,
  runAsUser: 10001,
  runAsGroup: 10001,
  fsGroup: 10001,
  fsGroupChangePolicy: 'OnRootMismatch',
};

const CONTAINER_SECURITY: Record<string, unknown> = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  privileged: false,
};

/** The volume types the restricted profile admits that the chart uses. */
const VOLUME_TYPES = ['persistentVolumeClaim', 'emptyDir', 'secret'];

/** 0440, the mode the secret files are mounted with. */
const SECRET_MODE = 0o440;

type Report = (message: string) => void;

function checkDeployment(deployment: Obj, digest: string, bad: Report): void {
  const want = (label: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      bad(`${label} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
    }
  };

  want('spec.replicas', at(deployment, 'spec', 'replicas'), 1);
  want('spec.strategy.type', at(deployment, 'spec', 'strategy', 'type'), 'Recreate');
  const pod = at(deployment, 'spec', 'template', 'spec');
  want('automountServiceAccountToken', at(pod, 'automountServiceAccountToken'), false);
  want('terminationGracePeriodSeconds', at(pod, 'terminationGracePeriodSeconds'), 15);
  // Service links would inject PINWALL_PORT=tcp://... for a Service named pinwall.
  want('enableServiceLinks', at(pod, 'enableServiceLinks'), false);
  for (const [key, value] of Object.entries(POD_SECURITY)) {
    want(`pod securityContext.${key}`, at(pod, 'securityContext', key), value);
  }
  want(
    'pod securityContext.seccompProfile.type',
    at(pod, 'securityContext', 'seccompProfile', 'type'),
    'RuntimeDefault',
  );
  for (const flag of ['hostNetwork', 'hostPID', 'hostIPC']) {
    if (at(pod, flag) === true) bad(`${flag} must not be set`);
  }

  const containers = [...list(at(pod, 'initContainers')), ...list(at(pod, 'containers'))];
  for (const c of containers) {
    const label = `container ${text(at(c, 'name'))}`;
    for (const [key, value] of Object.entries(CONTAINER_SECURITY)) {
      want(`${label} securityContext.${key}`, at(c, 'securityContext', key), value);
    }
    want(
      `${label} securityContext.capabilities.drop`,
      at(c, 'securityContext', 'capabilities', 'drop'),
      ['ALL'],
    );
    if (list(at(c, 'securityContext', 'capabilities', 'add')).length > 0) {
      bad(`${label} must not add capabilities`);
    }
  }

  const volumes = list(at(pod, 'volumes')).filter(isObj);
  const volume = (name: string) => volumes.find((v) => v.name === name);
  for (const v of volumes) {
    for (const type of Object.keys(v).filter((key) => key !== 'name')) {
      if (!VOLUME_TYPES.includes(type)) {
        bad(`volume ${text(v.name)} is a ${type} volume; only ${VOLUME_TYPES.join(', ')} are used`);
      }
    }
  }
  for (const c of containers) {
    for (const mount of list(at(c, 'volumeMounts'))) {
      if (!volume(text(at(mount, 'name')))) {
        bad(`${text(at(c, 'name'))} mounts the undefined volume ${text(at(mount, 'name'))}`);
      }
    }
  }

  const main = list(at(pod, 'containers')).find((c) => at(c, 'name') === 'pinwall');
  if (!main) {
    bad('there is no container named pinwall');
    return;
  }

  if (digest) want('the image', at(main, 'image'), `${REPOSITORY}@${digest}`);
  else if (!text(at(main, 'image')).startsWith(`${REPOSITORY}:`)) {
    bad(`the image must be ${REPOSITORY}:<tag> without a digest, found ${text(at(main, 'image'))}`);
  }

  const ports = list(at(main, 'ports')).filter(isObj);
  want('container port http', ports.find((p) => p.name === 'http')?.containerPort, 8080);

  want('livenessProbe httpGet', at(main, 'livenessProbe', 'httpGet'), {
    path: '/healthz',
    port: 'http',
  });
  want('readinessProbe httpGet', at(main, 'readinessProbe', 'httpGet'), {
    path: '/readyz',
    port: 'http',
  });
  want('startupProbe httpGet', at(main, 'startupProbe', 'httpGet'), {
    path: '/healthz',
    port: 'http',
  });
  want('startupProbe failureThreshold', at(main, 'startupProbe', 'failureThreshold'), 30);
  want('startupProbe periodSeconds', at(main, 'startupProbe', 'periodSeconds'), 2);

  const mounts = list(at(main, 'volumeMounts')).filter(isObj);
  const mountAt = (path: string) => mounts.find((m) => m.mountPath === path);
  const claimOrEmpty = (name: unknown) => {
    const v = volume(text(name));
    return v !== undefined && (isObj(v.persistentVolumeClaim) || isObj(v.emptyDir));
  };
  if (!claimOrEmpty(mountAt('/data')?.name)) {
    bad('/data must be mounted from a persistentVolumeClaim or an emptyDir');
  }
  if (!isObj(volume(text(mountAt('/tmp')?.name))?.emptyDir)) {
    bad('/tmp must be mounted from an emptyDir');
  }

  checkEnvironment(main, volumes, mountAt(SECRETS_DIR), want, bad);
}

/** The environment of the main container and the secret volume that its `_FILE` variables use. */
function checkEnvironment(
  main: unknown,
  volumes: Obj[],
  secretMount: Obj | undefined,
  want: (label: string, actual: unknown, expected: unknown) => void,
  bad: Report,
): void {
  const env = list(at(main, 'env')).filter(isObj);
  const seen = new Set<string>();
  for (const entry of env) {
    const name = text(entry.name);
    if (seen.has(name)) bad(`environment variable ${name} is set twice`);
    seen.add(name);
  }
  const value = (name: string) => env.find((e) => e.name === name)?.value;
  // Helm prints a large number from a values file as 9.5e+07 unless the chart writes it out.
  for (const entry of env) {
    if (/^\d(\.\d+)?e[+-]\d+$/.test(text(entry.value))) {
      bad(`${text(entry.name)} is ${text(entry.value)}, a number written in exponent form`);
    }
  }

  if (!text(value('PINWALL_PUBLIC_ORIGIN'))) bad('PINWALL_PUBLIC_ORIGIN must have a value');
  const metricsPort = value('PINWALL_METRICS_PORT');
  if (typeof metricsPort !== 'string') bad('PINWALL_METRICS_PORT must be set to a string');
  const metricsContainerPort = list(at(main, 'ports'))
    .filter(isObj)
    .find((p) => p.name === 'metrics')?.containerPort;
  want(
    'container port metrics',
    metricsContainerPort,
    metricsPort === '0' || typeof metricsPort !== 'string' ? undefined : Number(metricsPort),
  );

  const files: string[] = [];
  for (const entry of env) {
    const name = text(entry.name);
    if (SECRET_NAMES.includes(name)) {
      bad(`${name} is a secret and must not be set in the pod spec; use ${name}_FILE`);
      continue;
    }
    if (!name.endsWith('_FILE')) continue;
    if (!SECRET_NAMES.includes(name.slice(0, -'_FILE'.length))) {
      bad(`${name} is not the file form of a secret variable`);
    }
    const path = text(entry.value);
    if (!path.startsWith(`${SECRETS_DIR}/`)) {
      bad(`${name} must point into ${SECRETS_DIR}/, found ${path}`);
    } else files.push(path.slice(SECRETS_DIR.length + 1));
  }

  if (files.length === 0 && !secretMount) return;
  if (!secretMount) {
    bad(`${SECRETS_DIR} must be mounted, because ${files.length} variables read secret files`);
    return;
  }
  want('the secret mount readOnly', secretMount.readOnly, true);
  const secretVolume = volumes.find((v) => v.name === secretMount.name)?.secret;
  if (!isObj(secretVolume)) {
    bad(`${SECRETS_DIR} must be mounted from a secret volume`);
    return;
  }
  want('the secret volume defaultMode', secretVolume.defaultMode, SECRET_MODE);
  const keys = list(secretVolume.items).map((item) => text(at(item, 'key')));
  for (const file of files) {
    if (!keys.includes(file))
      bad(`a variable points at ${file}, which the secret volume does not carry`);
  }
  for (const key of keys) {
    if (!files.includes(key)) bad(`the secret volume carries ${key}, which no variable reads`);
  }
}

function checkNetworking(docs: Obj[], deployment: Obj | undefined, bad: Report): void {
  const kind = (k: string) => docs.filter((d) => d.kind === k);
  const label = (d: Obj) => `${text(d.kind)} ${text(at(d, 'metadata', 'name'))}`;
  const podLabels = at(deployment, 'spec', 'template', 'metadata', 'labels');
  const pod = at(deployment, 'spec', 'template', 'spec');
  const metricsPort = list(at(pod, 'containers'))
    .flatMap((c) => list(at(c, 'ports')))
    .filter(isObj)
    .find((p) => p.name === 'metrics')?.containerPort;

  const services = kind('Service');
  const portNames = (service: Obj) =>
    list(at(service, 'spec', 'ports'))
      .map((p) => text(at(p, 'name')))
      .join(', ');
  for (const service of services) {
    if (deployment && !covers(podLabels, at(service, 'spec', 'selector'))) {
      bad(`${label(service)}: its selector does not match the labels of the pods`);
    }
    const type = at(service, 'spec', 'type') ?? 'ClusterIP';
    if (type !== 'ClusterIP' && portNames(service).split(', ').includes('metrics')) {
      bad(`${label(service)}: a ${text(type)} Service must not expose the metrics port`);
    }
  }

  for (const ingress of kind('Ingress')) {
    for (const rule of list(at(ingress, 'spec', 'rules'))) {
      for (const path of list(at(rule, 'http', 'paths'))) {
        const backend = at(path, 'backend', 'service');
        const target = services.find((s) => at(s, 'metadata', 'name') === at(backend, 'name'));
        const port = text(at(backend, 'port', 'name'));
        if (!target)
          bad(
            `${label(ingress)}: the backend Service ${text(at(backend, 'name'))} is not rendered`,
          );
        else if (!portNames(target).split(', ').includes(port)) {
          bad(
            `${label(ingress)}: the backend port ${port} is not a port of ${label(target)} (${portNames(target)})`,
          );
        }
      }
    }
  }

  for (const monitor of kind('ServiceMonitor')) {
    const target = services.find((s) =>
      covers(at(s, 'metadata', 'labels'), at(monitor, 'spec', 'selector', 'matchLabels')),
    );
    if (!target) bad(`${label(monitor)}: its selector matches no rendered Service`);
    for (const endpoint of list(at(monitor, 'spec', 'endpoints'))) {
      if (at(endpoint, 'path') !== '/metrics') {
        bad(
          `${label(monitor)}: the endpoint path must be "/metrics", found ${text(at(endpoint, 'path'))}`,
        );
      }
      if (
        target &&
        !portNames(target)
          .split(', ')
          .includes(text(at(endpoint, 'port')))
      ) {
        bad(
          `${label(monitor)}: the endpoint port ${text(at(endpoint, 'port'))} is not a port of ${label(target)}`,
        );
      }
    }
  }

  for (const policy of kind('NetworkPolicy')) {
    const types = list(at(policy, 'spec', 'policyTypes'));
    if (deployment && !covers(podLabels, at(policy, 'spec', 'podSelector', 'matchLabels'))) {
      bad(`${label(policy)}: its podSelector does not select the pods`);
    }
    if (!types.includes('Ingress')) bad(`${label(policy)}: policyTypes must include Ingress`);
    for (const rule of list(at(policy, 'spec', 'ingress'))) {
      const opensMetrics = list(at(rule, 'ports')).some((p) => at(p, 'port') === metricsPort);
      if (opensMetrics && list(at(rule, 'from')).length === 0) {
        bad(
          `${label(policy)}: the rule for the metrics port ${text(metricsPort)} has no "from", so every pod could reach it`,
        );
      }
    }
    if (types.includes('Egress')) {
      const dns = (protocol: string) =>
        list(at(policy, 'spec', 'egress')).some(
          (rule) =>
            list(at(rule, 'to')).length === 0 &&
            list(at(rule, 'ports')).some(
              (p) => at(p, 'port') === 53 && (at(p, 'protocol') ?? 'TCP') === protocol,
            ),
        );
      if (!dns('UDP') || !dns('TCP')) {
        bad(`${label(policy)}: restricted egress must still allow DNS (port 53, UDP and TCP)`);
      }
    }
  }
}

/**
 * The problems in one render of the chart (its YAML documents), as a list of sentences; empty when
 * the render follows every rule of a hardened install. `digest` is the image digest the values
 * set, or `''` when the image is given by tag.
 */
export function chartInvariants(docs: unknown[], o: { digest: string }): string[] {
  const problems: string[] = [];
  const objects = docs.filter(isObj);
  const deployments = objects.filter((d) => d.kind === 'Deployment');
  if (deployments.length !== 1) {
    problems.push(`the chart must render exactly one Deployment, found ${deployments.length}`);
  }
  for (const secret of objects.filter((d) => d.kind === 'Secret')) {
    problems.push(
      `the chart must not render a Secret (${text(at(secret, 'metadata', 'name'))}); secrets come from existingSecret`,
    );
  }
  const [deployment] = deployments;
  if (deployment) {
    checkDeployment(deployment, o.digest, (message) =>
      problems.push(`Deployment ${text(at(deployment, 'metadata', 'name'))}: ${message}`),
    );
  }
  checkNetworking(objects, deployment, (message) => problems.push(message));
  return problems;
}

/**
 * The documents of rendered chart output. YAML 1.1 is read, because the chart writes the secret
 * file mode as the octal `0440`, as Kubernetes tools read it. Comment-only documents are skipped.
 */
export function parseRendered(rendered: string): { docs: unknown[]; errors: string[] } {
  const docs: unknown[] = [];
  const errors: string[] = [];
  for (const doc of parseAllDocuments(rendered, { version: '1.1' })) {
    errors.push(...doc.errors.map((error) => error.message));
    const value: unknown = doc.toJS();
    if (value !== null && value !== undefined) docs.push(value);
  }
  return { docs, errors };
}

/** A render the chart must refuse, with the text its error has to contain. */
export interface NegativeRender {
  name: string;
  /** Extra `helm template` arguments, applied over `ci/default-values.yaml`. */
  args: string[];
  message: string;
}

export function negativeRenders(): NegativeRender[] {
  const set = (...values: string[]) => values.flatMap((value) => ['--set', value]);
  return [
    { name: 'no publicOrigin', args: set('publicOrigin='), message: "at '/publicOrigin'" },
    {
      name: 'a publicOrigin with a path',
      args: set('publicOrigin=https://x.example/path'),
      message: "at '/publicOrigin'",
    },
    {
      name: 'an image.digest that is not a digest',
      args: set('image.digest=latest'),
      message: "at '/image/digest'",
    },
    {
      name: 'neither an image digest nor a tag',
      args: set('image.digest='),
      message: 'set image.digest (released charts carry it) or image.tag',
    },
    {
      name: 'a replica count',
      args: set('replicaCount=3'),
      message: 'replicaCount',
    },
    ...SECRET_NAMES.map((name) => ({
      name: `${name} set in env`,
      args: set(`env.${name}=inline-value`),
      message: `set ${name} through existingSecret and secretFiles, not env`,
    })),
    {
      name: 'the file form of a secret set in env',
      args: set('env.PINWALL_SECRET_KEY_FILE=/somewhere/key'),
      message: 'set PINWALL_SECRET_KEY through existingSecret and secretFiles, not env',
    },
    {
      name: 'a variable the chart sets itself, in env',
      args: set('env.PINWALL_PUBLIC_ORIGIN=https://other.example'),
      message: 'PINWALL_PUBLIC_ORIGIN',
    },
    {
      name: 'secretFiles without existingSecret',
      args: set('secretFiles.PINWALL_SECRET_KEY=secret-key'),
      message: 'existingSecret',
    },
    {
      name: 'existingSecret without secretFiles',
      args: set('existingSecret=pinwall-secrets'),
      message: 'secretFiles',
    },
    {
      name: 'a secretFiles entry that is not a secret variable',
      args: set('existingSecret=pinwall-secrets', 'secretFiles.PINWALL_LOG_LEVEL=level'),
      message: 'PINWALL_LOG_LEVEL',
    },
    {
      name: 'the metrics port set to the web port',
      args: set('metrics.port=8080'),
      message: 'metrics.port must differ from the web port',
    },
    {
      name: 'a ServiceMonitor with metrics off',
      args: set('metrics.enabled=false', 'metrics.serviceMonitor.enabled=true'),
      message: 'metrics.enabled',
    },
  ];
}

/** A successful render the invariants must accept, apart from the values files. */
interface Variant {
  name: string;
  /** `helm template` arguments, applied over `ci/default-values.yaml`. */
  args: string[];
  /** The digest the render sets; the one of `default-values.yaml` when left out. */
  digest?: string;
  /** Extra problems to report about the rendered documents. */
  expect?: (docs: Obj[]) => string[];
}

/** The host names the rendered Ingress routes. */
const ingressHosts = (docs: Obj[]): string[] =>
  docs
    .filter((d) => d.kind === 'Ingress')
    .flatMap((d) => list(at(d, 'spec', 'rules')).map((rule) => text(at(rule, 'host'))));

/** A check that the rendered Ingress routes exactly these hosts, in this order. */
const routes =
  (...hosts: string[]) =>
  (docs: Obj[]): string[] =>
    JSON.stringify(ingressHosts(docs)) === JSON.stringify(hosts)
      ? []
      : [`the Ingress must route ${hosts.join(', ')}, it routes ${ingressHosts(docs).join(', ')}`];

const VARIANTS: Variant[] = [
  {
    name: 'an image by tag',
    args: ['--set', 'image.digest=', '--set', 'image.tag=1.0.0'],
    digest: '',
  },
  { name: 'persistence off', args: ['--set', 'persistence.enabled=false'] },
  { name: 'metrics off', args: ['--set', 'metrics.enabled=false'] },
  { name: 'an existing claim', args: ['--set', 'persistence.existingClaim=pinwall-data'] },
  { name: 'a LoadBalancer Service', args: ['--set', 'service.type=LoadBalancer'] },
  { name: 'a network policy with its defaults', args: ['--set', 'networkPolicy.enabled=true'] },
  {
    name: 'an Ingress on the host of publicOrigin',
    args: ['--set', 'ingress.enabled=true'],
    expect: routes('pinwall.example.com'),
  },
  {
    name: 'an Ingress on listed hosts and a content host',
    args: [
      '--set',
      'ingress.enabled=true',
      '--set',
      'ingress.hosts={a.example,b.example}',
      '--set',
      'ingress.contentHost=*.content.example',
    ],
    expect: routes('a.example', 'b.example', '*.content.example'),
  },
];

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input?: string): Outcome {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { status: null, stdout: '', stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const INSTALL_HINTS: Record<string, string> = {
  helm: 'Helm 4.3 (https://helm.sh/docs/intro/install/)',
  kubeconform: 'kubeconform 0.8 (https://github.com/yannh/kubeconform/releases)',
};

/** The tools that are not on PATH, each with where to get it. */
function missingTools(): string[] {
  return Object.entries({ helm: ['version'], kubeconform: ['-v'] })
    .filter(([tool, args]) => run(tool, args).status !== 0)
    .map(([tool]) => `${tool} was not found on PATH; install ${INSTALL_HINTS[tool]}`);
}

const firstLines = (output: string, count = 12) =>
  output.trim().split('\n').slice(0, count).join('\n');

/** The checks for one render: invariants, then the Kubernetes schemas. */
function checkRender(
  label: string,
  outcome: Outcome,
  digest: string,
  failures: string[],
  expect: Variant['expect'] = undefined,
): void {
  if (outcome.status !== 0) {
    failures.push(`${label}: helm template failed\n${firstLines(outcome.stderr)}`);
    return;
  }
  const { docs, errors } = parseRendered(outcome.stdout);
  for (const error of errors) failures.push(`${label}: the output is not valid YAML: ${error}`);
  for (const problem of chartInvariants(docs, { digest })) failures.push(`${label}: ${problem}`);
  for (const problem of expect?.(docs.filter(isObj)) ?? []) failures.push(`${label}: ${problem}`);

  const schemas = run(
    'kubeconform',
    [
      '-strict',
      '-summary',
      '-kubernetes-version',
      KUBERNETES_VERSION,
      '-schema-location',
      'default',
      '-schema-location',
      CRD_SCHEMAS,
      '-',
    ],
    outcome.stdout,
  );
  if (schemas.status !== 0 || !/Invalid: 0, Errors: 0/.test(schemas.stdout)) {
    failures.push(
      `${label}: kubeconform rejected the render\n${firstLines(schemas.stdout + schemas.stderr, 30)}`,
    );
  } else console.log(`  ${schemas.stdout.trim().split('\n').pop()}`);
}

function main(): number {
  const missing = missingTools();
  if (missing.length > 0) {
    for (const message of missing) console.error(message);
    return 2;
  }

  const ciDir = join(CHART_DIR, 'ci');
  const files = readdirSync(ciDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  if (files.length === 0) {
    console.error(`no values files in ${ciDir}`);
    return 1;
  }
  const failures: string[] = [];
  const template = (args: string[]) =>
    run('helm', [
      'template',
      'pw',
      CHART_DIR,
      '--namespace',
      'pinwall',
      '--kube-version',
      KUBERNETES_VERSION,
      ...args,
    ]);
  const valuesOf = (file: string) => join(ciDir, file);
  const digestOf = (file: string): string => {
    const values: unknown = parse(readFileSync(valuesOf(file), 'utf8'));
    return text(at(values, 'image', 'digest'));
  };

  for (const file of files) {
    console.log(`ci/${file}`);
    const lint = run('helm', ['lint', '--strict', CHART_DIR, '-f', valuesOf(file)]);
    if (lint.status !== 0)
      failures.push(
        `helm lint --strict with ${file} failed\n${firstLines(lint.stdout + lint.stderr)}`,
      );
    checkRender(`render with ${file}`, template(['-f', valuesOf(file)]), digestOf(file), failures);
  }

  const base = 'default-values.yaml';
  for (const variant of VARIANTS) {
    console.log(`variant: ${variant.name}`);
    checkRender(
      `render with ${variant.name}`,
      template(['-f', valuesOf(base), ...variant.args]),
      variant.digest ?? digestOf(base),
      failures,
      variant.expect,
    );
  }

  for (const refusal of negativeRenders()) {
    const outcome = template(['-f', valuesOf(base), ...refusal.args]);
    const output = outcome.stdout + outcome.stderr;
    if (outcome.status === 0) failures.push(`${refusal.name}: the chart rendered, but must refuse`);
    else if (!output.includes(refusal.message)) {
      failures.push(
        `${refusal.name}: refused, but without "${refusal.message}"\n${firstLines(output)}`,
      );
    } else console.log(`refused: ${refusal.name}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:\n`);
    for (const failure of failures) console.error(`- ${failure}\n`);
    return 1;
  }
  console.log('\nchart check passed');
  return 0;
}

if (import.meta.main) process.exit(main());
