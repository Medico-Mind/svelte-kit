import zlib from 'node:zlib';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
	compressOnDemand,
	isCompressibleContentType,
	MIN_COMPRESS_SIZE
} from '../../src/runtime/compress-on-demand.js';

const BODY = `<html><body>${'dynamic content '.repeat(200)}</body></html>`;

function makeApp(respond: () => Response): Hono {
	const app = new Hono();
	app.use(compressOnDemand());
	app.get('/', () => respond());
	return app;
}

const html = (body: string = BODY, init: ResponseInit = {}) =>
	new Response(body, {
		...init,
		headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) }
	});

describe('compressOnDemand', () => {
	it('gzips a compressible response and drops content-length', async () => {
		const app = makeApp(() => html(BODY, { headers: { 'content-length': String(BODY.length) } }));
		const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(response.headers.get('content-length')).toBeNull();
		expect(response.headers.get('vary')).toBe('accept-encoding');
		expect(zlib.gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(BODY);
	});

	it('prefers zstd over br over gzip on q-value ties', async () => {
		const app = makeApp(() => html());
		const response = await app.request('/', { headers: { 'accept-encoding': 'gzip, br, zstd' } });

		expect(response.headers.get('content-encoding')).toBe('zstd');
		expect(zlib.zstdDecompressSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(
			BODY
		);
	});

	it('compresses with brotli when it is the only acceptable encoding', async () => {
		const app = makeApp(() => html());
		const response = await app.request('/', { headers: { 'accept-encoding': 'br' } });

		expect(response.headers.get('content-encoding')).toBe('br');
		expect(zlib.brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(
			BODY
		);
	});

	it('serves identity without Accept-Encoding, still marking vary', async () => {
		const app = makeApp(() => html());
		const response = await app.request('/');

		expect(response.headers.get('content-encoding')).toBeNull();
		expect(response.headers.get('vary')).toBe('accept-encoding');
		expect(await response.text()).toBe(BODY);
	});

	it('skips responses with a declared content-length below the threshold', async () => {
		const small = 'tiny';
		const app = makeApp(() => html(small, { headers: { 'content-length': String(small.length) } }));
		const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });

		expect(response.headers.get('content-encoding')).toBeNull();
		expect(response.headers.get('vary')).toBeNull();
		expect(await response.text()).toBe(small);
		expect(small.length).toBeLessThan(MIN_COMPRESS_SIZE);
	});

	it('skips non-compressible content types', async () => {
		const app = makeApp(() => new Response(BODY, { headers: { 'content-type': 'image/png' } }));
		const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });

		expect(response.headers.get('content-encoding')).toBeNull();
		expect(await response.text()).toBe(BODY);
	});

	it('leaves already-encoded responses untouched', async () => {
		const compressed = zlib.gzipSync(BODY);
		const app = makeApp(
			() =>
				new Response(new Uint8Array(compressed), {
					headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }
				})
		);
		const response = await app.request('/', { headers: { 'accept-encoding': 'zstd, gzip' } });

		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(Buffer.from(await response.arrayBuffer()).equals(compressed)).toBe(true);
	});

	it('honors cache-control: no-transform', async () => {
		const app = makeApp(() => html(BODY, { headers: { 'cache-control': 'public, no-transform' } }));
		const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });

		expect(response.headers.get('content-encoding')).toBeNull();
		expect(await response.text()).toBe(BODY);
	});

	it('skips partial-content responses', async () => {
		const app = makeApp(() => html(BODY, { status: 206 }));
		const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });

		expect(response.status).toBe(206);
		expect(response.headers.get('content-encoding')).toBeNull();
	});

	it('appends accept-encoding to an existing vary header without duplicating', async () => {
		const appended = makeApp(() => html(BODY, { headers: { vary: 'origin' } }));
		const appendedVary = (
			await appended.request('/', { headers: { 'accept-encoding': 'gzip' } })
		).headers.get('vary');
		expect(appendedVary?.toLowerCase().replace(/\s/g, '')).toBe('origin,accept-encoding');

		const already = makeApp(() => html(BODY, { headers: { vary: 'Accept-Encoding' } }));
		const alreadyVary = (
			await already.request('/', { headers: { 'accept-encoding': 'gzip' } })
		).headers.get('vary');
		expect(alreadyVary?.toLowerCase()).toBe('accept-encoding');
	});
});

describe('isCompressibleContentType', () => {
	it.each([
		'text/html; charset=utf-8',
		'text/css',
		'application/json',
		'application/javascript',
		'application/manifest+json',
		'application/atom+xml',
		'image/svg+xml',
		'application/wasm',
		'font/ttf'
	])('accepts %s', (type) => {
		expect(isCompressibleContentType(type)).toBe(true);
	});

	it.each([
		'image/png',
		'video/mp4',
		'application/octet-stream',
		'font/woff2',
		'text/event-stream'
	])('rejects %s', (type) => {
		expect(isCompressibleContentType(type)).toBe(false);
	});

	it('rejects a missing content-type', () => {
		expect(isCompressibleContentType(null)).toBe(false);
		expect(isCompressibleContentType('')).toBe(false);
	});
});
