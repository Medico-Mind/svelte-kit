import { createEnv, RUNTIME_ENV_VARS } from '../runtime/env-core.js';

/** The `envPrefix` this build was created with. */
export const prefix = ENV_PREFIX;

/** Values baked in via the adapter's `runtimeConfig` option — they win over process.env. */
const overrides: Record<string, string> = ENV_OVERRIDES;

/**
 * Reads a runtime environment variable, honoring the configured `envPrefix`.
 * Values fixed at build time via the adapter's `runtimeConfig` option take
 * precedence.
 */
export const env = createEnv(prefix, process.env, overrides);

const EXPECTED = new Set<string>(RUNTIME_ENV_VARS);

if (prefix) {
	for (const key of Object.keys(process.env)) {
		if (!key.startsWith(prefix)) continue;
		if (!EXPECTED.has(key.slice(prefix.length))) {
			console.warn(`Ignoring unknown environment variable ${key}`);
		}
	}
}
