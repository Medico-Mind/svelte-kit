/**
 * Per-request preprocessing for SSR: origin/protocol/host/port header
 * handling and request body size limiting.
 *
 * Everything here operates on fetch-native `Request` objects and streams —
 * bodies are never buffered.
 */
export interface SsrRequestConfig {
	/** Fixed origin (`https://example.com`); wins over the header options. */
	origin?: string | undefined;
	/** Lowercased header carrying the original protocol (e.g. `x-forwarded-proto`). */
	protocolHeader?: string | undefined;
	/** Lowercased header carrying the original host (e.g. `x-forwarded-host`). */
	hostHeader?: string | undefined;
	/** Lowercased header carrying the original port (e.g. `x-forwarded-port`). */
	portHeader?: string | undefined;
	/** Maximum request body size in bytes; `0` or `Infinity` disable the limit. */
	bodySizeLimit?: number | undefined;
}

/** Error used to abort a request body stream that exceeded the size limit. */
export class BodySizeLimitError extends Error {
	readonly status = 413;
	constructor(limit: number) {
		super(`Request body size exceeded the limit of ${limit} bytes`);
		this.name = 'BodySizeLimitError';
	}
}

/**
 * Wraps a request body stream so it errors as soon as more than `limit` bytes
 * flow through it. Chunks are passed through unbuffered.
 */
export function limitStream(
	body: ReadableStream<Uint8Array>,
	limit: number
): ReadableStream<Uint8Array> {
	let total = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.byteLength;
				if (total > limit) {
					controller.error(new BodySizeLimitError(limit));
				} else {
					controller.enqueue(chunk);
				}
			}
		})
	);
}

/** Takes the first element of a comma-separated header value. */
function first(value: string | null): string | undefined {
	return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Applies origin configuration and the body size limit to an incoming
 * request.
 *
 * Returns either the request to hand to SvelteKit (the original object when
 * nothing needed changing — the hot path allocates nothing) or an early
 * `Response` (413 when the declared `content-length` exceeds the limit).
 */
export function prepareSsrRequest(request: Request, config: SsrRequestConfig): Request | Response {
	const limit = config.bodySizeLimit ?? Infinity;

	const url = new URL(request.url);
	let urlChanged = false;

	if (config.origin) {
		const origin = new URL(config.origin);
		if (url.protocol !== origin.protocol || url.host !== origin.host) {
			url.protocol = origin.protocol;
			url.hostname = origin.hostname;
			url.port = origin.port;
			urlChanged = true;
		}
	} else {
		const protocol = config.protocolHeader && first(request.headers.get(config.protocolHeader));
		const host = config.hostHeader && first(request.headers.get(config.hostHeader));
		const port = config.portHeader && first(request.headers.get(config.portHeader));

		if (protocol) {
			url.protocol = `${protocol}:`;
			urlChanged = true;
		}
		if (host) {
			const colon = host.lastIndexOf(':');
			// an IPv6 literal without port contains ':' but ends with ']'
			const hasPort = colon !== -1 && !host.endsWith(']');
			url.hostname = hasPort ? host.slice(0, colon) : host;
			url.port = hasPort ? host.slice(colon + 1) : '';
			urlChanged = true;
		}
		if (port) {
			url.port = port;
			urlChanged = true;
		}
	}

	let body = request.body;
	let bodyChanged = false;

	if (body && limit > 0 && limit !== Infinity) {
		const declared = request.headers.get('content-length');
		if (declared) {
			const length = Number(declared);
			if (Number.isFinite(length) && length > limit) {
				return new Response(`Content-length of ${length} exceeds limit of ${limit} bytes.`, {
					status: 413,
					headers: { 'content-type': 'text/plain' }
				});
			}
		}
		// guard the actual bytes too — content-length can lie or be absent
		body = limitStream(body, limit);
		bodyChanged = true;
	}

	if (!urlChanged && !bodyChanged) return request;

	return new Request(url, {
		method: request.method,
		headers: request.headers,
		body,
		signal: request.signal,
		// undici requires half-duplex for stream bodies
		duplex: body ? 'half' : undefined
	});
}
