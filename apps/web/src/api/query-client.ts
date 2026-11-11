import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './client.ts';

const MAX_RETRIES = 2;

/** A 4xx answer will not change on a retry: the request itself was refused. */
function isClientError(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500;
}

/**
 * The app's query client. Queries stay fresh for 30 seconds and retry at most
 * twice, only for network, server and malformed-response errors. Mutations
 * never retry: repeating a write is the person's call.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => failureCount < MAX_RETRIES && !isClientError(error),
      },
      mutations: { retry: false },
    },
  });
}
