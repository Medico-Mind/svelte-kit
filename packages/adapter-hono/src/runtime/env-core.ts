/**
 * Environment variable helpers shared by the build templates and unit tests.
 */

/** The runtime environment variables recognized by the emitted server. */
export const RUNTIME_ENV_VARS = [
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
	'COMPRESS_ON_DEMAND',
	'SHUTDOWN_TIMEOUT',
	'IDLE_TIMEOUT'
] as const;

/** A runtime environment variable name (always unprefixed). */
export type RuntimeEnvVar = (typeof RUNTIME_ENV_VARS)[number];

/** Reads an (optionally prefixed) environment variable. */
export interface EnvReader {
	(name: string): string | undefined;
	(name: string, fallback: string): string;
}

/**
 * Creates an environment reader that resolves `name` as `${prefix}${name}`
 * against `source` (defaults to `process.env`).
 *
 * `overrides` (keyed by unprefixed name) win over `source` — used for values
 * baked in at build time via the adapter's `runtimeConfig` option.
 *
 * A variable that is present but empty wins over the fallback, matching
 * `adapter-node` semantics.
 */
export function createEnv(
	prefix: string,
	source: NodeJS.ProcessEnv = process.env,
	overrides: Record<string, string> = {}
): EnvReader {
	const reader = (name: string, fallback?: string): string | undefined => {
		if (name in overrides) return overrides[name];
		const key = `${prefix}${name}`;
		return key in source ? source[key] : fallback;
	};
	return reader as EnvReader;
}

/**
 * Parses a boolean environment variable: `true`/`1` (case-insensitive) are
 * true, `false`/`0`/empty are false. Throws on anything else.
 */
export function parseBooleanEnv(input: string): boolean {
	const value = input.trim().toLowerCase();
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0' || value === '') return false;
	throw new Error(`Invalid boolean '${input}'. Expected 'true'/'1' or 'false'/'0'.`);
}

const SIZE_UNITS: Record<string, number> = {
	k: 1024,
	m: 1024 ** 2,
	g: 1024 ** 3
};

/**
 * Parses a `BODY_SIZE_LIMIT`-style value into a number of bytes.
 *
 * Accepts a plain byte count (`1048576`), a `K`/`M`/`G` suffix (`512K`, `1M`,
 * `2G`, case-insensitive) or `Infinity`. Both `0` and `Infinity` disable the
 * limit. Throws on anything else.
 */
export function parseBodySizeLimit(input: string): number {
	const value = input.trim();
	if (/^infinity$/i.test(value)) return Infinity;

	const match = /^(\d+(?:\.\d+)?)([kmg])?$/i.exec(value);
	if (!match) {
		throw new Error(
			`Invalid body size limit '${input}'. Expected a number of bytes with an optional K/M/G suffix, or 'Infinity'.`
		);
	}

	const [, amount = '', unit] = match;
	const multiplier = unit ? (SIZE_UNITS[unit.toLowerCase()] ?? 1) : 1;
	return Number(amount) * multiplier;
}
