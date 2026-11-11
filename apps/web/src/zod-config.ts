import { z } from 'zod';

/*
 * The app's Content-Security-Policy has no 'unsafe-eval'. By default zod
 * checks whether it may compile schemas with `new Function("")` when it builds
 * them, which the browser reports as a violation on every page load although
 * zod catches the error. Jitless skips that check (and the compiled fast path
 * it would allow). Schemas are built when `@pinwall/shared` loads, so this
 * module must be the app's first import.
 */
z.config({ jitless: true });
