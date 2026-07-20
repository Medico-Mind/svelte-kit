import { Readable, type Duplex } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { constants, createBrotliCompress, createGzip, createZstdCompress } from 'node:zlib';

import type { MiddlewareHandler } from 'hono';

import { COMPRESSED_ENCODINGS, selectEncoding, type CompressedEncoding } from './negotiate.js';

/**
 * Responses with a declared `content-length` below this are left alone —
 * matches the precompression threshold, where compression stops paying off.
 */
export const MIN_COMPRESS_SIZE = 1024;

/** Non-`text/*` media types that still compress well. */
const COMPRESSIBLE_TYPES = new Set([
	'application/json',
	'application/javascript',
	'application/x-javascript',
	'application/ecmascript',
	'application/xml',
	'application/wasm',
	'application/rtf',
	'application/x-www-form-urlencoded',
	'application/vnd.ms-fontobject',
	'image/svg+xml',
	'font/ttf',
	'font/otf'
]);

/**
 * Whether a `content-type` header value denotes a compressible body:
 * `text/*` (except `text/event-stream`, which must not be buffered),
 * `+json`/`+xml` structured syntaxes, and a small allowlist of other types.
 */
export function isCompressibleContentType(header: string | null): boolean {
	if (!header) return false;
	const [mime = ''] = header.split(';', 1);
	const type = mime.trim().toLowerCase();
	if (type === 'text/event-stream') return false;
	if (type.startsWith('text/')) return true;
	if (type.endsWith('+json') || type.endsWith('+xml')) return true;
	return COMPRESSIBLE_TYPES.has(type);
}

// Levels are tuned for per-request latency, unlike the build-time
// precompression which maxes them out: gzip 6 (zlib default), brotli 4,
// zstd 3 (zlib default).
function createEncoder(encoding: CompressedEncoding, sizeHint: number | undefined): Duplex {
	switch (encoding) {
		case 'gzip':
			return createGzip();
		case 'br':
			return createBrotliCompress({
				params: {
					[constants.BROTLI_PARAM_QUALITY]: 4,
					...(sizeHint === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint })
				}
			});
		case 'zstd':
			return createZstdCompress();
	}
}

function appendVary(headers: Headers): void {
	const vary = headers.get('vary');
	if (!vary) {
		headers.set('vary', 'accept-encoding');
		return;
	}
	const listed = vary
		.toLowerCase()
		.split(',')
		.map((value) => value.trim());
	if (!listed.includes('accept-encoding') && !listed.includes('*')) {
		headers.append('vary', 'accept-encoding');
	}
}

/**
 * Hono middleware compressing responses on the fly with `node:zlib`, using the
 * same `Accept-Encoding` negotiation as precompressed sidecars
 * (`zstd > br > gzip` on q-value ties).
 *
 * A response is compressed only when it has a body, a 2xx/3xx/4xx/5xx status
 * other than 206/304 (204 has no body), no `content-encoding` of its own
 * (precompressed sidecars pass through untouched), no
 * `cache-control: no-transform`, a compressible `content-type`, and no
 * declared `content-length` below {@link MIN_COMPRESS_SIZE}. Bodies are
 * streamed through the encoder, never buffered.
 */
export function compressOnDemand(): MiddlewareHandler {
	return async (c, next) => {
		await next();

		const response = c.res;
		if (!response.body || c.req.method === 'HEAD') return;

		const { status, headers } = response;
		if (status === 206 || status === 304) return;
		if (headers.has('content-encoding')) return;
		if (/(?:^|,)\s*no-transform\s*(?:$|[,;])/i.test(headers.get('cache-control') ?? '')) return;
		if (!isCompressibleContentType(headers.get('content-type'))) return;

		const declaredLength = headers.get('content-length');
		const size = declaredLength === null ? undefined : Number(declaredLength);
		if (size !== undefined && size < MIN_COMPRESS_SIZE) return;

		// the response is negotiable from here on, whichever encoding wins
		appendVary(headers);

		const encoding = selectEncoding(c.req.header('accept-encoding'), COMPRESSED_ENCODINGS);
		if (encoding === 'identity') return;

		const compressed = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>).pipe(
			createEncoder(encoding, size)
		);

		c.res = new Response(
			Readable.toWeb(compressed) as unknown as ReadableStream<Uint8Array>,
			response
		);
		c.res.headers.delete('content-length');
		c.res.headers.set('content-encoding', encoding);
	};
}
