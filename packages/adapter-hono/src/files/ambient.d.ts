/**
 * Placeholder module specifiers used by the runtime templates. `adapt()`
 * rewrites them to relative paths inside the emitted build; these ambient
 * declarations exist purely so the templates typecheck.
 */

declare module 'SERVER' {
	import type { Server } from '@sveltejs/kit';
	export const server: Server;
}

declare module 'MANIFEST' {
	export const prerendered: Set<string>;
	export const base: string;
	/** Application path including the base path, e.g. `base/_app` (no leading slash). */
	export const appPath: string;
}

declare module 'ENV' {
	export const prefix: string;
	export function env(name: string): string | undefined;
	export function env(name: string, fallback: string): string;
}

declare module 'HANDLER' {
	import type { Hono } from 'hono';
	export const app: Hono;
	export const handler: (request: Request) => Promise<Response>;
}

/** Replaced with the JSON-encoded `envPrefix` adapter option at adapt time. */
declare const ENV_PREFIX: string;

/**
 * Replaced at adapt time with the JSON-encoded `runtimeConfig` adapter option,
 * mapped onto environment variable names with stringified values.
 */
declare const ENV_OVERRIDES: Record<string, string>;

declare module 'ASSETS' {
	import type { AssetManifest } from '../runtime/assets.js';
	export const client: AssetManifest;
	export const prerendered: AssetManifest;
}
