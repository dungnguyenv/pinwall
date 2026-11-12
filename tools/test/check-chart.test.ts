import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  CHART_DIR,
  chartInvariants,
  negativeRenders,
  parseRendered,
  SECRET_NAMES,
} from '../src/check-chart.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `ghcr.io/dungnguyenv/pinwall@${DIGEST}`;
const LABELS = { 'app.kubernetes.io/name': 'pinwall', 'app.kubernetes.io/instance': 'pw' };

/** A deep copy that a test can change without touching the shared fixture. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/** A Deployment that follows every rule, with persistence and one mounted secret. */
function goodDeployment() {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'pw-pinwall' },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: LABELS },
      template: {
        metadata: { labels: LABELS },
        spec: {
          serviceAccountName: 'pw-pinwall',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 15,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            fsGroupChangePolicy: 'OnRootMismatch',
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'pinwall',
              image: IMAGE,
              ports: [
                { name: 'http', containerPort: 8080 },
                { name: 'metrics', containerPort: 9464 },
              ],
              env: [
                { name: 'PINWALL_PUBLIC_ORIGIN', value: 'https://pinwall.example.com' },
                { name: 'PINWALL_METRICS_PORT', value: '9464' },
                { name: 'PINWALL_SECRET_KEY_FILE', value: '/run/secrets/pinwall/secret-key' },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                privileged: false,
                capabilities: { drop: ['ALL'] },
              },
              livenessProbe: { httpGet: { path: '/healthz', port: 'http' } },
              readinessProbe: { httpGet: { path: '/readyz', port: 'http' } },
              startupProbe: {
                httpGet: { path: '/healthz', port: 'http' },
                failureThreshold: 30,
                periodSeconds: 2,
              },
              volumeMounts: [
                { name: 'data', mountPath: '/data' },
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'secrets', mountPath: '/run/secrets/pinwall', readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: 'data', persistentVolumeClaim: { claimName: 'pw-pinwall' } },
            { name: 'tmp', emptyDir: {} },
            {
              name: 'secrets',
              secret: {
                secretName: 'pinwall-secrets',
                defaultMode: 0o440,
                items: [{ key: 'secret-key', path: 'secret-key' }],
              },
            },
          ],
        },
      },
    },
  };
}

type Deployment = ReturnType<typeof goodDeployment>;

/** The one container of `goodDeployment`, for tests to change. */
function container(d: Deployment) {
  const [first] = d.spec.template.spec.containers;
  if (!first) throw new Error('fixture has no container');
  return first;
}

const NOTHING_WRONG: string[] = [];

test('a Deployment that follows every rule has no problems', () => {
  expect(chartInvariants([goodDeployment()], { digest: DIGEST })).toEqual(NOTHING_WRONG);
});

test('a container without readOnlyRootFilesystem is one problem, and it names the field', () => {
  const d = copy(goodDeployment());
  Reflect.deleteProperty(container(d).securityContext, 'readOnlyRootFilesystem');
  const problems = chartInvariants([d], { digest: DIGEST });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('readOnlyRootFilesystem');
});

test('every broken rule is reported, not only the first', () => {
  const d = copy(goodDeployment());
  d.spec.replicas = 2;
  d.spec.strategy.type = 'RollingUpdate';
  d.spec.template.spec.automountServiceAccountToken = true;
  d.spec.template.spec.enableServiceLinks = true;
  d.spec.template.spec.securityContext.fsGroup = 0;
  container(d).securityContext.capabilities.drop = ['NET_RAW'];
  const text = chartInvariants([d], { digest: DIGEST }).join('\n');
  for (const field of [
    'replicas',
    'strategy.type',
    'automountServiceAccountToken',
    'enableServiceLinks',
    'fsGroup',
    'capabilities.drop',
  ]) {
    expect(text).toContain(field);
  }
});

test('the image is the digest reference when a digest is set, and repository:tag otherwise', () => {
  const byTag = copy(goodDeployment());
  container(byTag).image = 'ghcr.io/dungnguyenv/pinwall:1.0.0';
  expect(chartInvariants([byTag], { digest: '' })).toEqual(NOTHING_WRONG);
  expect(chartInvariants([byTag], { digest: DIGEST }).join('\n')).toContain('image');

  const other = copy(goodDeployment());
  container(other).image = `docker.io/library/nginx@${DIGEST}`;
  expect(chartInvariants([other], { digest: DIGEST }).join('\n')).toContain('image');
});

test('a secret variable written inline in the pod spec is a problem', () => {
  const d = copy(goodDeployment());
  container(d).env.push({ name: 'PINWALL_DATABASE_URL', value: 'postgres://u:p@db/x' });
  const problems = chartInvariants([d], { digest: DIGEST });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('PINWALL_DATABASE_URL');
});

test('a number written in exponent form is a problem', () => {
  const d = copy(goodDeployment());
  container(d).env.push({ name: 'PINWALL_MAX_UPLOAD_BYTES', value: '9.5e+07' });
  const problems = chartInvariants([d], { digest: DIGEST });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('PINWALL_MAX_UPLOAD_BYTES');
});

test('a secret file the volume does not carry is a problem', () => {
  const d = copy(goodDeployment());
  container(d).env.push({
    name: 'PINWALL_S3_ACCESS_KEY_ID_FILE',
    value: '/run/secrets/pinwall/ak',
  });
  const problems = chartInvariants([d], { digest: DIGEST });
  expect(problems.join('\n')).toContain('ak');
});

test('an environment variable named twice is a problem', () => {
  const d = copy(goodDeployment());
  container(d).env.push({ name: 'PINWALL_METRICS_PORT', value: '1' });
  expect(chartInvariants([d], { digest: DIGEST }).join('\n')).toContain('PINWALL_METRICS_PORT');
});

test('a hostPath volume, a missing /tmp volume and a wrong secret mode are problems', () => {
  const hostPath = copy(goodDeployment());
  hostPath.spec.template.spec.volumes.push({ name: 'host', hostPath: { path: '/' } } as never);
  expect(chartInvariants([hostPath], { digest: DIGEST }).join('\n')).toContain('hostPath');

  const noTmp = copy(goodDeployment());
  container(noTmp).volumeMounts = container(noTmp).volumeMounts.filter((m) => m.name !== 'tmp');
  expect(chartInvariants([noTmp], { digest: DIGEST }).join('\n')).toContain('/tmp');

  const mode = copy(goodDeployment());
  const secret = mode.spec.template.spec.volumes.find((v) => v.name === 'secrets')?.secret;
  if (secret) secret.defaultMode = 0o644;
  expect(chartInvariants([mode], { digest: DIGEST }).join('\n')).toContain('defaultMode');
});

test('the data volume may be an emptyDir (persistence off)', () => {
  const d = copy(goodDeployment());
  d.spec.template.spec.volumes[0] = { name: 'data', emptyDir: {} } as never;
  expect(chartInvariants([d], { digest: DIGEST })).toEqual(NOTHING_WRONG);
});

test('the probes must use the documented paths and the startup budget', () => {
  const d = copy(goodDeployment());
  container(d).readinessProbe.httpGet.path = '/healthz';
  container(d).startupProbe.failureThreshold = 3;
  const text = chartInvariants([d], { digest: DIGEST }).join('\n');
  expect(text).toContain('readinessProbe');
  expect(text).toContain('startupProbe');
});

test('the chart must render exactly one Deployment and no Secret', () => {
  expect(chartInvariants([], { digest: DIGEST }).join('\n')).toContain('Deployment');
  expect(
    chartInvariants([goodDeployment(), goodDeployment()], { digest: DIGEST }).join('\n'),
  ).toContain('Deployment');
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'leak' } };
  const problems = chartInvariants([goodDeployment(), secret], { digest: DIGEST });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('Secret');
});

const service = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'pw-pinwall', labels: LABELS },
  spec: {
    selector: LABELS,
    ports: [
      { name: 'http', port: 80, targetPort: 'http' },
      { name: 'metrics', port: 9464, targetPort: 'metrics' },
    ],
  },
};

test('a Service whose selector does not match the pods is a problem', () => {
  expect(chartInvariants([goodDeployment(), service], { digest: DIGEST })).toEqual(NOTHING_WRONG);
  const wrong = copy(service);
  wrong.spec.selector = { 'app.kubernetes.io/name': 'other' } as never;
  expect(chartInvariants([goodDeployment(), wrong], { digest: DIGEST }).join('\n')).toContain(
    'selector',
  );
});

test('a Service that is reachable from outside the cluster must not expose the metrics port', () => {
  const exposed = copy(service);
  (exposed.spec as { type?: string }).type = 'LoadBalancer';
  const problems = chartInvariants([goodDeployment(), exposed], { digest: DIGEST });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('metrics');
  const webOnly = copy(exposed);
  webOnly.spec.ports = webOnly.spec.ports.filter((p) => p.name === 'http');
  expect(chartInvariants([goodDeployment(), webOnly], { digest: DIGEST })).toEqual(NOTHING_WRONG);
});

test('an Ingress or a ServiceMonitor must name a port the Service has', () => {
  const ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: 'pw-pinwall' },
    spec: {
      rules: [
        {
          host: 'pinwall.example.com',
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'pw-pinwall', port: { name: 'web' } } },
              },
            ],
          },
        },
      ],
    },
  };
  expect(
    chartInvariants([goodDeployment(), service, ingress], { digest: DIGEST }).join('\n'),
  ).toContain('web');

  const monitor = {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'ServiceMonitor',
    metadata: { name: 'pw-pinwall' },
    spec: {
      selector: { matchLabels: LABELS },
      endpoints: [{ port: 'metrics', path: '/metrics' }],
    },
  };
  expect(chartInvariants([goodDeployment(), service, monitor], { digest: DIGEST })).toEqual(
    NOTHING_WRONG,
  );
  const badPath = copy(monitor);
  badPath.spec.endpoints = [{ port: 'metrics', path: '/stats' }];
  expect(
    chartInvariants([goodDeployment(), service, badPath], { digest: DIGEST }).join('\n'),
  ).toContain('/metrics');
});

test('a NetworkPolicy must not let everyone reach the metrics port', () => {
  const policy = (from: unknown[]) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'pw-pinwall' },
    spec: {
      podSelector: { matchLabels: LABELS },
      policyTypes: ['Ingress'],
      ingress: [
        { ports: [{ port: 8080 }] },
        { ports: [{ port: 9464 }], ...(from.length > 0 ? { from } : {}) },
      ],
    },
  });
  const open = chartInvariants([goodDeployment(), policy([])], { digest: DIGEST });
  expect(open).toHaveLength(1);
  expect(open[0]).toContain('9464');
  expect(
    chartInvariants([goodDeployment(), policy([{ namespaceSelector: {} }])], { digest: DIGEST }),
  ).toEqual(NOTHING_WRONG);
});

test('a restricted-egress NetworkPolicy must still allow DNS', () => {
  const policy = (egress: unknown[]) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'pw-pinwall' },
    spec: {
      podSelector: { matchLabels: LABELS },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ ports: [{ port: 8080 }] }],
      egress,
    },
  });
  const dns = {
    ports: [
      { port: 53, protocol: 'UDP' },
      { port: 53, protocol: 'TCP' },
    ],
  };
  expect(chartInvariants([goodDeployment(), policy([dns])], { digest: DIGEST })).toEqual(
    NOTHING_WRONG,
  );
  expect(chartInvariants([goodDeployment(), policy([])], { digest: DIGEST }).join('\n')).toContain(
    'DNS',
  );
});

test('the secret names are the secret variables of the configuration catalog', () => {
  expect([...SECRET_NAMES].sort()).toEqual([
    'PINWALL_DATABASE_URL',
    'PINWALL_OIDC_CLIENT_SECRET',
    'PINWALL_S3_ACCESS_KEY_ID',
    'PINWALL_S3_SECRET_ACCESS_KEY',
    'PINWALL_SECRET_KEY',
  ]);
});

test('the chart template lists exactly the catalog secrets', async () => {
  const helpers = await readFile(join(CHART_DIR, 'templates/_helpers.tpl'), 'utf8');
  const body = /define "pinwall\.secretNames"\s*-?}}([\s\S]*?){{-?\s*end/.exec(helpers)?.[1];
  expect(body, 'pinwall.secretNames is defined in _helpers.tpl').toBeDefined();
  expect((body ?? '').trim().split(/\s+/).sort()).toEqual([...SECRET_NAMES].sort());
});

test('every catalog secret has a negative render that sets it inline in env', () => {
  const cases = negativeRenders();
  for (const name of SECRET_NAMES) {
    const found = cases.find((c) => c.args.includes(`env.${name}=inline-value`));
    expect(found, `a negative render for env.${name}`).toBeDefined();
    expect(found?.message).toMatch(/existingSecret/);
    expect(found?.message).toMatch(/secretFiles/);
  }
});

test('rendered YAML is read with octal file modes, so 0440 is 288', () => {
  const { docs, errors } = parseRendered(
    'a: 1\n---\n# only a comment\n---\nmode: 0440\nflag: "yes"\n',
  );
  expect(errors).toEqual([]);
  expect(docs).toEqual([{ a: 1 }, { mode: 288, flag: 'yes' }]);
  expect(parseRendered('a: [1\n').errors).not.toEqual([]);
});
