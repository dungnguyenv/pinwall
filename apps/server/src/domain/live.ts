import type { LiveEvent } from '@pinwall/shared';
import type { AppDeps } from '../deps.ts';
import { ARTIFACT_TOPIC } from './search.ts';

/**
 * Sends `event` to everyone following its artifact's live updates. Call it once the change has
 * committed, so listeners never see a change that was rolled back.
 */
export function publishLive(deps: AppDeps, event: LiveEvent): void {
  deps.events.publish(ARTIFACT_TOPIC(event.artifact_id), event);
}
