import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from './client.ts';
import { OAuthConsentRequest, type OAuthDecisionRequest, OAuthDecisionResult } from './dto.ts';
import { qk } from './keys.ts';

/*
 * The consent page's side of Pinwall's OAuth authorization server. The server
 * hands a client's authorization request to `/oauth/consent?request=<id>`;
 * these calls read it and answer it with the browser session.
 */

/** Who asks, what for, where the answer goes, and for whom. */
export function getConsentRequest(id: string): Promise<OAuthConsentRequest> {
  return api(`/oauth/requests/${encodeURIComponent(id)}`, { schema: OAuthConsentRequest });
}

/**
 * Allows or denies the request. The answer names where the browser goes next:
 * the client's redirect URI carrying the code or the refusal. It is used once
 * and never cached, since it may hold the authorization code.
 */
export function decideConsent(id: string, approve: boolean): Promise<OAuthDecisionResult> {
  const body: OAuthDecisionRequest = { approve };
  return api(`/oauth/requests/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body,
    schema: OAuthDecisionResult,
  });
}

/** The request, read once: it does not change while it waits, and ends once answered. */
export function useConsentRequest(id: string): UseQueryResult<OAuthConsentRequest, ApiError> {
  return useQuery<OAuthConsentRequest, ApiError>({
    queryKey: qk.consent(id),
    queryFn: () => getConsentRequest(id),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
