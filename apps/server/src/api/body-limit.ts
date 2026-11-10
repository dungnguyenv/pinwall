import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { payloadTooLarge } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/**
 * Route-level guard for routes with a JSON body: more than 64 KiB is a `payload_too_large`.
 * It lives apart from `router.ts` because route modules import it and `router.ts` imports them.
 */
export const jsonBodyLimit: MiddlewareHandler = bodyLimit({
  maxSize: 65_536,
  onError: () => {
    throw payloadTooLarge(t('error.tooLarge'));
  },
});
