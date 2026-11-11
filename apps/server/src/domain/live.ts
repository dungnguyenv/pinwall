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

/** The bus topic on which the live streams of share link `linkId` hear that it stopped working. */
export const SHARE_LINK_TOPIC = (linkId: string): string => `share-link:${linkId}`;

/**
 * Ends the live streams of share link `linkId` at once. Call it once its revoke has committed;
 * a stream that opens later checks the link as it opens.
 */
export function endShareLinkStreams(deps: AppDeps, linkId: string): void {
  deps.events.publish(SHARE_LINK_TOPIC(linkId), { type: 'share-link.revoked' });
}
