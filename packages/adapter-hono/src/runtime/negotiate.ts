/**
 * `Accept-Encoding` negotiation for precompressed sidecar files.
 *
 * Preference when q-values tie: `zstd` > `br` > `gzip` > identity.
 */

/** Compressed encodings this adapter can serve, in tie-break preference order. */
export const COMPRESSED_ENCODINGS = ['zstd', 'br', 'gzip'] as const;

/** A content encoding with a precompressed sidecar file. */
export type CompressedEncoding = (typeof COMPRESSED_ENCODINGS)[number];

/** Any encoding the static file server may respond with. */
export type ContentEncoding = CompressedEncoding | 'identity';

/** Sidecar file extension for each compressed encoding. */
export const SIDECAR_EXTENSIONS: Record<CompressedEncoding, string> = {
	zstd: '.zst',
	br: '.br',
	gzip: '.gz'
};

/**
 * Parses an `Accept-Encoding` header value into a map of
 * lowercased encoding token → q-value.
 *
 * Malformed q-values are treated as `q=0` (not acceptable), out-of-range
 * q-values are clamped to `[0, 1]`, and the first occurrence of a token wins.
 */
export function parseEncodingHeader(header: string): Map<string, number> {
	const table = new Map<string, number>();

	for (const part of header.split(',')) {
		const [token = '', ...params] = part.trim().split(';');
		const name = token.trim().toLowerCase();
		if (!name) continue;

		let q = 1;
		for (const param of params) {
			const [key, value] = param.split('=').map((s) => s.trim().toLowerCase());
			if (key !== 'q') continue;
			const parsed = value?.trim() ? Number(value) : NaN;
			q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
		}

		if (!table.has(name)) table.set(name, q);
	}

	return table;
}

/**
 * Picks the best content encoding to serve, given the request's
 * `Accept-Encoding` header and the encodings for which sidecar files exist.
 *
 * - A missing/empty header selects `identity`.
 * - Unknown encodings are ignored.
 * - `*` applies to any available encoding not mentioned explicitly.
 * - When q-values tie, preference is `zstd` > `br` > `gzip`.
 * - Explicit identity preferences participate in ranking. Otherwise identity
 *   is the fallback, unless excluded by identity;q=0 or *;q=0.
 * - Returns undefined if no representation is acceptable (406).
 */
export function selectEncoding(
	header: string | null | undefined,
	available: Iterable<CompressedEncoding>
): ContentEncoding | undefined {
	if (!header) return 'identity';

	const availableSet = new Set(available);

	const table = parseEncodingHeader(header);
	const wildcard = table.get('*');

	let best: ContentEncoding = 'identity';
	let bestQ = 0;

	for (const name of COMPRESSED_ENCODINGS) {
		if (!availableSet.has(name)) continue;
		const q = table.get(name) ?? wildcard ?? 0;
		// strict `>` keeps earlier (more preferred) encodings on q-value ties
		if (q > bestQ) {
			best = name;
			bestQ = q;
		}
	}

	const identityQ = table.get('identity');
	if (identityQ !== undefined && identityQ > bestQ) return 'identity';
	if (bestQ > 0) return best;
	return (identityQ ?? (wildcard === 0 ? 0 : 1)) > 0 ? 'identity' : undefined;
}
