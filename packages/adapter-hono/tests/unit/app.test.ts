import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildHonoApp, type BuildAppOptions } from '../../src/runtime/app.js';

const PAGE = `<html><body>prerendered page ${'x'.repeat(64)}</body></html>`;
const ASSET = 'static asset content '.repeat(20);

let clientRoot: string;
let prerenderedRoot: string;

/** SSR stub that reports how it was called. */
const ssr: BuildAppOptions['ssr'] = async (request, context) => {
	const url = new URL(request.url);
	if (url.pathname === '/ssr/address') return new Response(context.getClientAddress());
	if (url.pathname === '/ssr/url') return new Response(request.url);
	if (request.method === 'POST') {
		const body = await request.arrayBuffer();
		return new Response(`ssr-post:${body.byteLength}`);
	}
	return new Response(`ssr:${url.pathname}`, { status: url.pathname === '/missing' ? 404 : 200 });
};

function makeApp(overrides: Partial<BuildAppOptions> = {}) {
	return buildHonoApp({
		ssr,
		client: { root: clientRoot, immutablePathPrefix: '/_app/immutable/' },
		prerendered: {
			root: prerenderedRoot,
			prerenderedPaths: new Set(['/about', '/docs/'])
		},
		...overrides
	});
}

beforeAll(() => {
	clientRoot = mkdtempSync(path.join(tmpdir(), 'adapter-hono-client-'));
	prerenderedRoot = mkdtempSync(path.join(tmpdir(), 'adapter-hono-prerendered-'));

	mkdirSync(path.join(clientRoot, '_app/immutable'), { recursive: true });
	writeFileSync(path.join(clientRoot, '_app/immutable/chunk.js'), 'export const x = 1;');
	writeFileSync(path.join(clientRoot, 'favicon.png'), 'not-really-a-png');
	writeFileSync(path.join(clientRoot, 'asset.txt'), ASSET);
	writeFileSync(path.join(clientRoot, 'asset.txt.gz'), zlib.gzipSync(ASSET));

	writeFileSync(path.join(prerenderedRoot, 'about.html'), PAGE);
	writeFileSync(path.join(prerenderedRoot, 'about.html.br'), zlib.brotliCompressSync(PAGE));
	mkdirSync(path.join(prerenderedRoot, 'docs'), { recursive: true });
	writeFileSync(path.join(prerenderedRoot, 'docs/index.html'), PAGE);
	writeFileSync(path.join(prerenderedRoot, 'data.json'), '{"prerendered":true}');
});

afterAll(() => {
	rmSync(clientRoot, { recursive: true, force: true });
	rmSync(prerenderedRoot, { recursive: true, force: true });
});

describe('static assets', () => {
	it('serves client files with no-cache semantics', async () => {
		const response = await makeApp().request('/asset.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-cache');
		expect(await response.text()).toBe(ASSET);
	});

	it('serves immutable assets with long-lived cache headers', async () => {
		const response = await makeApp().request('/_app/immutable/chunk.js');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, immutable, max-age=31536000');
		expect(response.headers.get('content-type')).toContain('javascript');
	});

	it('negotiates precompressed variants', async () => {
		const response = await makeApp().request('/asset.txt', {
			headers: { 'accept-encoding': 'gzip;q=0.9, br;q=0.1' }
		});
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(response.headers.get('vary')).toBe('accept-encoding');
		expect(zlib.gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(ASSET);
	});

	it('lets non-GET requests fall through to SSR', async () => {
		const response = await makeApp().request('/asset.txt', { method: 'POST', body: 'hi' });
		expect(await response.text()).toBe('ssr-post:2');
	});

	it('supports HEAD for static files', async () => {
		const response = await makeApp().request('/asset.txt', { method: 'HEAD' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});
});

describe('prerendered pages', () => {
	it('serves <path>.html for extensionless paths', async () => {
		const response = await makeApp().request('/about');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toBe(PAGE);
	});

	it('serves <path>/index.html for trailing-slash paths', async () => {
		const response = await makeApp().request('/docs/');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(PAGE);
	});

	it('serves prerendered endpoints at their exact path', async () => {
		const response = await makeApp().request('/data.json');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"prerendered":true}');
	});

	it('negotiates precompressed prerendered pages', async () => {
		const response = await makeApp().request('/about', {
			headers: { 'accept-encoding': 'br' }
		});
		expect(response.headers.get('content-encoding')).toBe('br');
		expect(zlib.brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(
			PAGE
		);
	});

	it('308-redirects to the prerendered trailing-slash variant, keeping the query', async () => {
		const app = makeApp();

		const addSlash = await app.request('/docs?x=1');
		expect(addSlash.status).toBe(308);
		expect(addSlash.headers.get('location')).toBe('/docs/?x=1');

		const removeSlash = await app.request('/about/?y=2');
		expect(removeSlash.status).toBe(308);
		expect(removeSlash.headers.get('location')).toBe('/about?y=2');
	});
});

describe('SSR fallthrough', () => {
	it('forwards unknown paths to the SSR handler', async () => {
		const response = await makeApp().request('/anything/else');
		expect(await response.text()).toBe('ssr:/anything/else');
	});

	it('propagates SSR status codes', async () => {
		const response = await makeApp().request('/missing');
		expect(response.status).toBe(404);
	});

	it('rewrites the request URL when ORIGIN is configured', async () => {
		const response = await makeApp({ origin: 'https://example.com' }).request('/ssr/url?a=1');
		expect(await response.text()).toBe('https://example.com/ssr/url?a=1');
	});

	it('responds 413 when the declared body exceeds BODY_SIZE_LIMIT', async () => {
		const response = await makeApp({ bodySizeLimit: 16 }).request('/submit', {
			method: 'POST',
			body: 'x'.repeat(64),
			headers: { 'content-length': '64' }
		});
		expect(response.status).toBe(413);
	});

	it('responds 413 when an undeclared (chunked) body exceeds BODY_SIZE_LIMIT mid-stream', async () => {
		const response = await makeApp({ bodySizeLimit: 16 }).request('/submit', {
			method: 'POST',
			body: 'x'.repeat(64)
		});
		expect(response.status).toBe(413);
	});

	it('passes allowed bodies through to SSR', async () => {
		const response = await makeApp({ bodySizeLimit: 1024 }).request('/submit', {
			method: 'POST',
			body: 'x'.repeat(64)
		});
		expect(await response.text()).toBe('ssr-post:64');
	});

	it('resolves the client address from ADDRESS_HEADER and XFF_DEPTH', async () => {
		const app = makeApp({ addressHeader: 'x-forwarded-for', xffDepth: 2 });
		const response = await app.request('/ssr/address', {
			headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.2, 10.0.0.1' }
		});
		expect(await response.text()).toBe('198.51.100.2');
	});

	it('falls back to the socket address provider', async () => {
		const app = makeApp({ getSocketAddress: () => '192.0.2.7' });
		const response = await app.request('/ssr/address');
		expect(await response.text()).toBe('192.0.2.7');
	});

	it('rejects an invalid xffDepth at construction time', () => {
		expect(() => makeApp({ xffDepth: 0 })).toThrow(/positive integer/);
	});
});

describe('handler composition', () => {
	it('works without client/prerendered directories (SSR only)', async () => {
		const app = buildHonoApp({ ssr });
		const response = await app.request('/about');
		expect(await response.text()).toBe('ssr:/about');
	});

	it('can be mounted inside a user Hono app', async () => {
		const { Hono } = await import('hono');
		const root = new Hono();
		root.get('/custom', (c) => c.text('custom'));
		root.route('/', makeApp());

		expect(await (await root.request('/custom')).text()).toBe('custom');
		expect((await root.request('/about')).status).toBe(200);
		expect(await (await root.request('/ssr/url')).text()).toBe('http://localhost/ssr/url');
	});
});
