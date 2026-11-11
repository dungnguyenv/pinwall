import { stopPinwall } from './pinwall-server.ts';

export default async function globalTeardown(): Promise<void> {
  await stopPinwall();
}
