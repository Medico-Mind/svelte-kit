import { createEnv } from '../runtime/env-core.js';

/** The `envPrefix` this build was created with. */
export const prefix = ENV_PREFIX;

/**
 * Reads a runtime environment variable, honoring the configured `envPrefix`.
 */
export const env = createEnv(prefix);

const EXPECTED = new Set([
	'PORT',
	'HOST',
	'SOCKET_PATH',
	'ORIGIN',
	'PROTOCOL_HEADER',
	'HOST_HEADER',
	'PORT_HEADER',
	'ADDRESS_HEADER',
	'XFF_DEPTH',
	'BODY_SIZE_LIMIT',
	'SHUTDOWN_TIMEOUT',
	'IDLE_TIMEOUT'
]);

if (prefix) {
	for (const key of Object.keys(process.env)) {
		if (!key.startsWith(prefix)) continue;
		if (!EXPECTED.has(key.slice(prefix.length))) {
			console.warn(`Ignoring unknown environment variable ${key}`);
		}
	}
}
