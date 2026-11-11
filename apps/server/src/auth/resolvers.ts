import { apiTokenResolver } from './api-tokens.ts';
import type { BearerResolver } from './resolve.ts';

/**
 * Bearer kinds `/api/v1/*` and `/a/*` accept: personal API tokens, and nothing else. OAuth
 * access tokens must never work there. M6 builds its own list for `/mcp` alone,
 * `[oauthAccessTokenResolver, ...bearerResolvers]`, and never adds its resolver to this one.
 */
export const bearerResolvers: readonly BearerResolver[] = [apiTokenResolver];
