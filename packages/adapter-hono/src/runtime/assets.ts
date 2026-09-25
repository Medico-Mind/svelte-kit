import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import {
	compressBody,
	isCompressibleContentType,
	MIN_COMPRESS_SIZE
} from './compress-on-demand.js';
import { COMPRESSED_ENCODINGS, selectEncoding, type CompressedEncoding } from './negotiate.js';

/** One concrete file on disk that can satisfy a request. */
export interface AssetVariant {
	filePath: string;
	/** Quoted SHA-256 of these exact bytes. */
	etag: string;
	size: number;
}

/** A servable asset plus its precompressed sidecar variants. */
export interface AssetEntry extends AssetVariant {
	contentType: string;
	/** Available precompressed variants, keyed by content encoding. */
	encodings: Map<CompressedEncoding, AssetVariant>;
}

/** Prebuilt pathname → entry lookup; generated at build time, no fs on the hot path. */
export type AssetManifest = Map<string, AssetEntry>;

/** A single satisfiable byte range. */
interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parses a `Range` header for a single byte range against a file of `size`
 * bytes. Returns `undefined` for malformed/multi-range headers (caller should
 * ignore the header and serve 200) and `'unsatisfiable'` for ranges outside
 * the file (caller should respond 416).
 */
export function parseRangeHeader(
	header: string,
	size: number
): ByteRange | 'unsatisfiable' | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return undefined;
	const [, rawStart = '', rawEnd = ''] = match;
	if (!rawStart && !rawEnd) return undefined;

	if (!rawStart) {
		// suffix form: last N bytes
		const suffix = Number(rawEnd);
		if (suffix === 0 || size === 0) return 'unsatisfiable';
		return { start: Math.max(size - suffix, 0), end: size - 1 };
	}

	const start = Number(rawStart);
	const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

export interface ServeAssetOptions {
	/** Value for the `cache-control` header; omitted when not set. */
	cacheControl?: string | undefined;
	compressOnDemand?: boolean | undefined;
}

function fileBody(filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
	const stream = range
		? createReadStream(filePath, { start: range.start, end: range.end })
		: createReadStream(filePath);
	return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Serves an asset entry as a fetch `Response`, handling `Accept-Encoding`
 * negotiation against the entry's sidecar variants, conditional requests
 * (`if-none-match` → 304), single-range requests (identity encoding only, per
 * RFC 9110 recommendations) and `HEAD`.
 */
export function serveAsset(
	request: Request,
	entry: AssetEntry,
	options: ServeAssetOptions = {}
): Response {
	const headers = new Headers();
	if (options.cacheControl) headers.set('cache-control', options.cacheControl);

	const rangeHeader = request.headers.get('range');

	const acceptEncoding = request.headers.get('accept-encoding');
	const canCompress =
		!rangeHeader &&
		options.compressOnDemand &&
		entry.size >= MIN_COMPRESS_SIZE &&
		isCompressibleContentType(entry.contentType) &&
		!/(?:^|,)\s*no-transform\s*(?:$|[,;])/i.test(options.cacheControl ?? '');
	let encoding = selectEncoding(acceptEncoding, rangeHeader ? [] : entry.encodings.keys());
	// Preserve sidecar preference; compress on demand only when no sidecar was selected.
	if (canCompress && (encoding === 'identity' || encoding === undefined)) {
		encoding = selectEncoding(acceptEncoding, COMPRESSED_ENCODINGS);
	}
	if (entry.encodings.size > 0 || canCompress || encoding === undefined)
		headers.set('vary', 'accept-encoding');
	if (encoding === undefined) return new Response(null, { status: 406, headers });

	const sidecar = encoding === 'identity' ? undefined : entry.encodings.get(encoding);
	const dynamic = encoding !== 'identity' && !sidecar;
	const variant: AssetVariant = sidecar ?? entry;
	// On-demand bytes may differ across zlib versions; their validator must be weak.
	const etag = dynamic ? `W/"${entry.etag.slice(1, -1)}-runtime-${encoding}"` : variant.etag;
	headers.set('etag', etag);
	headers.set('content-type', entry.contentType);
	headers.set('accept-ranges', 'bytes');
	if (encoding !== 'identity') headers.set('content-encoding', encoding);

	if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}

	const isHead = request.method === 'HEAD';

	if (
		rangeHeader &&
		(!request.headers.has('if-range') || request.headers.get('if-range') === etag)
	) {
		const range = parseRangeHeader(rangeHeader, variant.size);
		if (range === 'unsatisfiable') {
			headers.set('content-range', `bytes */${variant.size}`);
			return new Response(null, { status: 416, headers });
		}
		if (range) {
			headers.set('content-range', `bytes ${range.start}-${range.end}/${variant.size}`);
			headers.set('content-length', String(range.end - range.start + 1));
			return new Response(isHead ? null : fileBody(variant.filePath, range), {
				status: 206,
				headers
			});
		}
		// malformed range: fall through and serve the full file
	}

	if (!dynamic) headers.set('content-length', String(variant.size));
	const body = isHead ? null : fileBody(variant.filePath);
	return new Response(
		body && dynamic && encoding !== 'identity' ? compressBody(body, encoding, variant.size) : body,
		{ status: 200, headers }
	);
}

/** GET/HEAD use weak comparison, including lists and the wildcard. */
export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
	if (!header) return false;
	if (header === etag || header.trim() === '*') return true;
	const opaque = etag.replace(/^W\//, '');
	// Commas may occur inside an opaque tag, so do not split the field on commas.
	return [...header.matchAll(/(?:^|,)\s*(?:W\/)?("[^"\r\n]*")\s*(?=,|$)/g)].some(
		(match) => match[1] === opaque
	);
}
