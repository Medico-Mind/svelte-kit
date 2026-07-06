/**
 * Re-export of the composable Hono app (and fetch-style handler) for
 * embedding into a user-owned Hono server:
 *
 * ```js
 * import { Hono } from 'hono';
 * import { app } from './build/app.js';
 *
 * const root = new Hono();
 * root.route('/', app);
 * ```
 */
export { app, handler } from 'HANDLER';
