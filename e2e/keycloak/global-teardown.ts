import { cleanUpKeycloakRun } from './global-setup.ts';

export default async function globalTeardown(): Promise<void> {
  await cleanUpKeycloakRun();
}
