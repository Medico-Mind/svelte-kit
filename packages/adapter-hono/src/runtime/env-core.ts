/**
 * Environment variable helpers shared by the build templates and unit tests.
 */

/** Reads an (optionally prefixed) environment variable. */
export interface EnvReader {
	(name: string): string | undefined;
	(name: string, fallback: string): string;
}

/**
 * Creates an environment reader that resolves `name` as `${prefix}${name}`
 * against `source` (defaults to `process.env`).
 *
 * A variable that is present but empty wins over the fallback, matching
 * `adapter-node` semantics.
 */
export function createEnv(prefix: string, source: NodeJS.ProcessEnv = process.env): EnvReader {
	const reader = (name: string, fallback?: string): string | undefined => {
		const key = `${prefix}${name}`;
		return key in source ? source[key] : fallback;
	};
	return reader as EnvReader;
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
