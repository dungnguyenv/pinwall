import { startPinwall } from './pinwall-server.ts';

export default async function globalSetup(): Promise<void> {
  const port = Number(process.env.PINWALL_E2E_PORT ?? 18087);
  const pinwall = await startPinwall({ port });
  // The workers are started after this and inherit it.
  process.env.PINWALL_E2E_SETUP_URL = pinwall.setupUrl;
}
