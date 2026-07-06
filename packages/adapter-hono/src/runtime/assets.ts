import { createReadStream, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { contentType } from './mime.js';
import {
	COMPRESSED_ENCODINGS,
	SIDECAR_EXTENSIONS,
	selectEncoding,
	type CompressedEncoding
} from './negotiate.js';

/** One concrete file on disk that can satisfy a request. */
export interface AssetVariant {
	filePath: string;
	size: number;
}

/** A servable asset plus its precompressed sidecar variants. */
export interface AssetEntry extends AssetVariant {
	/** Decoded URL pathname this entry is served under, e.g. `/_app/x.js`. */
	pathname: string;
	mtime: Date;
	/** Opaque validator (without quotes/encoding suffix). */
	etag: string;
	/** Available precompressed variants, keyed by content encoding. */
	encodings: Map<CompressedEncoding, AssetVariant>;
}

/** Prebuilt pathname → entry lookup; resolved once at boot, no fs on the hot path. */
export type AssetManifest = Map<string, AssetEntry>;

function walk(root: string, dir: string, out: string[]): void {
	for (const dirent of readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = dir ? `${dir}/${dirent.name}` : dirent.name;
		if (dirent.isDirectory()) walk(root, rel, out);
		else if (dirent.isFile()) out.push(rel);
	}
}

/**
 * Walks `root` once (at boot) and builds the asset manifest. Files named
 * `<asset>.gz` / `.br` / `.zst` next to `<asset>` are registered as
 * precompressed variants of it (and remain directly addressable as well).
 */
export function createAssetManifest(root: string): AssetManifest {
	const relPaths: string[] = [];
	walk(root, '', relPaths);

	const manifest: AssetManifest = new Map();

	for (const rel of relPaths) {
		const filePath = path.join(root, rel);
		const stats = statSync(filePath);
		manifest.set(`/${rel}`, {
			pathname: `/${rel}`,
			filePath,
			size: stats.size,
			mtime: stats.mtime,
			etag: `${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}`,
			encodings: new Map()
		});
	}

	for (const encoding of COMPRESSED_ENCODINGS) {
		const ext = SIDECAR_EXTENSIONS[encoding];
		for (const [pathname, entry] of manifest) {
			if (!pathname.endsWith(ext)) continue;
			const base = manifest.get(pathname.slice(0, -ext.length));
			base?.encodings.set(encoding, { filePath: entry.filePath, size: entry.size });
		}
	}

	return manifest;
}

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

	// never negotiate encodings for range requests
	const encoding =
		rangeHeader || entry.encodings.size === 0
			? 'identity'
			: selectEncoding(request.headers.get('accept-encoding'), entry.encodings.keys());

	if (entry.encodings.size > 0) headers.set('vary', 'accept-encoding');

	const variant: AssetVariant =
		encoding === 'identity' ? entry : (entry.encodings.get(encoding) ?? entry);

	const etag = `W/"${entry.etag}${encoding === 'identity' ? '' : `-${encoding}`}"`;
	headers.set('etag', etag);
	headers.set('last-modified', entry.mtime.toUTCString());
	headers.set('content-type', contentType(entry.pathname));
	headers.set('accept-ranges', 'bytes');
	if (encoding !== 'identity') headers.set('content-encoding', encoding);

	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers });
	}

	const isHead = request.method === 'HEAD';

	if (rangeHeader) {
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

	headers.set('content-length', String(variant.size));
	return new Response(isHead ? null : fileBody(variant.filePath), { status: 200, headers });
}
