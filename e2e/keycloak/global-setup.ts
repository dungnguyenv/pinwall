import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OWNER } from '../support/in-page-api.ts';
import { type RunningPinwall, startPinwall, stopPinwall } from '../support/pinwall-server.ts';

const run = promisify(execFile);

/** The container this suite owns: it is removed by this exact name, and nothing else is. */
const CONTAINER = 'pinwall-e2e-keycloak';

/** Keycloak 26.8.2, by digest of its multi-arch index, so the run uses the image that was tested. */
const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.2@sha256:723b1d6e254c0fc96d5cffec860c7e0744d6a3277822b865bb538cf891575e41';

const KEYCLOAK_PORT = 18180;
const PINWALL_PORT = 18096;
const REALM_FILE = join(import.meta.dirname, 'realm.json');

/** The first start pulls the image, so `docker run` gets time for that. */
const RUN_TIMEOUT_MS = 600_000;
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const LOG_TAIL_LINES = 40;

const ISSUER = `http://localhost:${KEYCLOAK_PORT}/realms/pinwall`;

async function docker(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run('docker', args, {
    env: env ?? process.env,
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the realm's discovery document is being served. */
async function realmIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function containerIsRunning(): Promise<boolean> {
  try {
    return (
      (await docker(['inspect', '--format', '{{.State.Running}}', CONTAINER])).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/** The end of the container's log, for the message of a start that failed. */
async function logTail(): Promise<string> {
  try {
    const { stdout, stderr } = await run('docker', [
      'logs',
      '--tail',
      String(LOG_TAIL_LINES),
      CONTAINER,
    ]);
    return `${stdout}${stderr}`.trim();
  } catch {
    return '(no container log)';
  }
}

/** Waits until the imported realm answers, failing early when the container has stopped. */
async function waitForRealm(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await realmIsUp()) return;
    if (!(await containerIsRunning())) {
      throw new Error(
        `Keycloak stopped before it was ready\n--- container log (tail) ---\n${await logTail()}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Keycloak did not serve ${ISSUER} within ${READY_TIMEOUT_MS / 1000} s\n` +
      `--- container log (tail) ---\n${await logTail()}`,
  );
}

/** Removes the suite's container by name; having none to remove is not an error. */
async function removeContainer(): Promise<void> {
  try {
    await docker(['rm', '--force', CONTAINER]);
  } catch (error) {
    if (!String((error as { stderr?: unknown }).stderr).includes('No such container')) throw error;
  }
}

/**
 * Pinwall shows no sign-in options until its owner account exists, so this makes it, through the
 * one-time setup link, as a person opening that link would.
 */
async function createOwner(pinwall: RunningPinwall): Promise<void> {
  const token = new URL(pinwall.setupUrl).searchParams.get('token');
  const response = await fetch(new URL('/api/v1/auth/setup', pinwall.origin), {
    method: 'POST',
    // Pinwall's CSRF check wants the public origin on every request that changes something.
    headers: { 'content-type': 'application/json', origin: pinwall.origin },
    body: JSON.stringify({ token, name: OWNER.name, password: OWNER.password }),
  });
  if (response.status !== 201) {
    throw new Error(`Pinwall's owner setup answered ${response.status}`);
  }
}

/**
 * Starts Keycloak with the `pinwall` realm imported, then Pinwall against it. The workers start
 * after this; they only need the two origins, which the config fixes.
 */
export default async function globalSetup(): Promise<void> {
  try {
    // A container left by a run that was killed would block the name.
    await removeContainer();
    // The password is random per run and reaches Docker through the environment, so it is in
    // no command line.
    await docker(
      [
        'run',
        '--detach',
        '--name',
        CONTAINER,
        '--publish',
        `127.0.0.1:${KEYCLOAK_PORT}:8080`,
        '--env',
        'KC_BOOTSTRAP_ADMIN_USERNAME=admin',
        '--env',
        'KC_BOOTSTRAP_ADMIN_PASSWORD',
        '--volume',
        `${REALM_FILE}:/opt/keycloak/data/import/pinwall.json:ro`,
        KEYCLOAK_IMAGE,
        'start-dev',
        '--import-realm',
      ],
      { ...process.env, KC_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(24).toString('base64url') },
    );
    await waitForRealm();
    const pinwall = await startPinwall({
      port: PINWALL_PORT,
      env: {
        PINWALL_OIDC_ISSUER: ISSUER,
        PINWALL_OIDC_CLIENT_ID: 'pinwall',
        PINWALL_OIDC_CLIENT_SECRET: 'pinwall-e2e-client-secret',
        PINWALL_OIDC_DISPLAY_NAME: 'Keycloak',
        PINWALL_OIDC_ROLES_CLAIM: 'groups',
        PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
        PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-members',
        // Keycloak runs on plain http on this machine; Pinwall refuses that unless told.
        PINWALL_OIDC_ALLOW_HTTP_ISSUER: 'true',
      },
    });
    await createOwner(pinwall);
  } catch (error) {
    await cleanUpKeycloakRun();
    throw error;
  }
}

/** Stops Pinwall and removes the Keycloak container. Safe to call twice, and after a failed setup. */
export async function cleanUpKeycloakRun(): Promise<void> {
  const results = await Promise.allSettled([stopPinwall(), removeContainer()]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
