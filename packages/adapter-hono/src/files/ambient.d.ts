/**
 * Placeholder module specifiers used by the runtime templates. `adapt()`
 * rewrites them to relative paths inside the emitted build; these ambient
 * declarations exist purely so the templates typecheck.
 */

declare module 'SERVER' {
	export { Server } from '@sveltejs/kit';
}

declare module 'MANIFEST' {
	import type { SSRManifest } from '@sveltejs/kit';
	export const manifest: SSRManifest;
	export const prerendered: Set<string>;
	export const base: string;
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

declare module 'SHIMS' {
	// side-effect only
}

/** Replaced with the JSON-encoded `envPrefix` adapter option at adapt time. */
declare const ENV_PREFIX: string;

/**
 * Replaced at adapt time with the JSON-encoded `runtimeConfig` adapter option,
 * mapped onto environment variable names with stringified values.
 */
declare const ENV_OVERRIDES: Record<string, string>;
