import { apiTokenResolver } from './api-tokens.ts';
import type { BearerResolver } from './resolve.ts';

/** Bearer kinds `/api/v1` and `/a/*` accept. M6 adds the OAuth access-token resolver. */
export const bearerResolvers: BearerResolver[] = [apiTokenResolver];
