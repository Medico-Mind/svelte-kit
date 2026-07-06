import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import type { Builder } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import adapter, { type RuntimeConfig } from '../../src/index.js';
import { detectZstd } from '../../src/compress.js';
import { rawRequest, spawnServer, type SpawnedServer } from '../helpers/http.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// must live inside the package so the adapt-time rolldown can resolve hono from node_modules
const scratch = path.join(pkgDir, '.test-tmp', `adapter-${process.pid}`);
const out = path.join(scratch, 'build');

const LARGE = 'static text that compresses well. '.repeat(200);
const PRERENDERED_HTML = `<html><body>prerendered ${'y'.repeat(2000)}</body></html>`;
const IMMUTABLE_JS = `export const chunk = ${JSON.stringify('z'.repeat(2000))};`;

const zstdSupported = detectZstd() !== null;

/**
 * Stands in for SvelteKit's generated server module: same surface
 * (`Server#init`, `Server#respond`) with introspectable behavior.
 */
const STUB_SERVER = `
export class Server {
	constructor(manifest) {
		this.manifest = manifest;
	}
	async init({ env, read }) {
		this.env = env;
		this.read = read;
	}
	async respond(request, { getClientAddress }) {
		const url = new URL(request.url);
		if (url.pathname === '/echo-address') return new Response(getClientAddress());
		if (url.pathname === '/echo-url') return new Response(request.url);
		if (url.pathname === '/slow') {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return new Response('slow-done');
		}
		if (request.method === 'POST') {
			const body = await request.arrayBuffer();
			return new Response('len:' + body.byteLength);
		}
		return new Response('ssr:' + url.pathname, { headers: { 'content-type': 'text/plain' } });
	}
}
`;

function fakeBuilder(overrides: { basePath?: string } = {}): Builder {
	const base = overrides.basePath ?? '';
	const log = Object.assign((message: string) => void message, {
		info: () => {},
		minor: () => {},
		warn: () => {},
		error: () => {},
		success: () => {}
	});

	return {
		log,
		rimraf: (dir: string) => rmSync(dir, { recursive: true, force: true }),
		mkdirp: (dir: string) => mkdirSync(dir, { recursive: true }),
		config: { kit: { paths: { base } } },
		prerendered: { paths: ['/prerendered'] },
		getBuildDirectory: (name: string) => path.join(scratch, 'kit', name),
		writeClient(dest: string) {
			mkdirSync(path.join(dest, '_app/immutable'), { recursive: true });
			writeFileSync(path.join(dest, '_app/immutable/chunk.js'), IMMUTABLE_JS);
			writeFileSync(path.join(dest, 'large.txt'), LARGE);
			writeFileSync(path.join(dest, 'small.txt'), 'tiny');
			return [];
		},
		writePrerendered(dest: string) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'prerendered.html'), PRERENDERED_HTML);
			return [];
		},
		writeServer(dest: string) {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, 'index.js'), STUB_SERVER);
			return [];
		},
		generateManifest: () =>
			`{ appDir: "_app", appPath: "_app", assets: new Set([]), mimeTypes: {}, _: {} }`
	} as unknown as Builder;
}

describe('adapter.adapt()', () => {
	beforeAll(async () => {
		rmSync(scratch, { recursive: true, force: true });
		mkdirSync(scratch, { recursive: true });
		await adapter({ out, precompress: true }).adapt(fakeBuilder());
	}, 120_000);

	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it('emits the documented output layout', () => {
		for (const file of ['index.js', 'handler.js', 'app.js', 'env.js', 'shims.js']) {
			expect(existsSync(path.join(out, file)), file).toBe(true);
		}
		expect(existsSync(path.join(out, 'client/large.txt'))).toBe(true);
		expect(existsSync(path.join(out, 'prerendered/prerendered.html'))).toBe(true);
	});

	it('bundles hono into the output (no bare import statements left)', () => {
		const content = ['index.js', 'handler.js', 'app.js']
			.map((file) => readFileSync(path.join(out, file), 'utf8'))
			.join('\n');
		const importStatements =
			/^\s*(?:import|export)[^\n]*from\s*['"](hono|@hono\/node-server|SERVER|MANIFEST|HANDLER|SHIMS|ENV)['"]/m;
		expect(content).not.toMatch(importStatements);
	});

	it('writes precompressed sidecars for eligible files only', () => {
		expect(existsSync(path.join(out, 'client/large.txt.gz'))).toBe(true);
		expect(existsSync(path.join(out, 'client/large.txt.br'))).toBe(true);
		expect(existsSync(path.join(out, 'client/large.txt.zst'))).toBe(zstdSupported);
		expect(existsSync(path.join(out, 'client/small.txt.gz'))).toBe(false);
		expect(existsSync(path.join(out, 'prerendered/prerendered.html.gz'))).toBe(true);
	});

	describe('emitted server', () => {
		let server: SpawnedServer;

		beforeAll(async () => {
			server = await spawnServer(path.join(out, 'index.js'), {
				ADDRESS_HEADER: 'x-client-ip',
				BODY_SIZE_LIMIT: '64'
			});
		}, 60_000);

		afterAll(async () => {
			await server?.stop();
		});

		it('serves SSR routes', async () => {
			const response = await rawRequest(`${server.baseUrl}/anything`);
			expect(response.status).toBe(200);
			expect(response.body.toString()).toBe('ssr:/anything');
		});

		it('serves static assets with encoding negotiation', async () => {
			const identity = await rawRequest(`${server.baseUrl}/large.txt`);
			expect(identity.headers['content-encoding']).toBeUndefined();
			expect(identity.body.toString()).toBe(LARGE);

			const brotli = await rawRequest(`${server.baseUrl}/large.txt`, {
				headers: { 'accept-encoding': 'br' }
			});
			expect(brotli.headers['content-encoding']).toBe('br');
			expect(brotli.headers.vary).toBe('accept-encoding');
			expect(zlib.brotliDecompressSync(brotli.body).toString()).toBe(LARGE);

			const negotiated = await rawRequest(`${server.baseUrl}/large.txt`, {
				headers: { 'accept-encoding': 'zstd, br, gzip' }
			});
			expect(negotiated.headers['content-encoding']).toBe(zstdSupported ? 'zstd' : 'br');
		});

		it('serves immutable assets with immutable cache headers', async () => {
			const response = await rawRequest(`${server.baseUrl}/_app/immutable/chunk.js`);
			expect(response.status).toBe(200);
			expect(response.headers['cache-control']).toBe('public, immutable, max-age=31536000');
		});

		it('serves prerendered pages with trailing-slash redirects', async () => {
			const page = await rawRequest(`${server.baseUrl}/prerendered`);
			expect(page.status).toBe(200);
			expect(page.body.toString()).toBe(PRERENDERED_HTML);

			const redirect = await rawRequest(`${server.baseUrl}/prerendered/`);
			expect(redirect.status).toBe(308);
			expect(redirect.headers.location).toBe('/prerendered');
		});

		it('resolves the client address from ADDRESS_HEADER', async () => {
			const response = await rawRequest(`${server.baseUrl}/echo-address`, {
				headers: { 'x-client-ip': '203.0.113.5' }
			});
			expect(response.body.toString()).toBe('203.0.113.5');
		});

		it('enforces BODY_SIZE_LIMIT', async () => {
			const allowed = await rawRequest(`${server.baseUrl}/upload`, {
				method: 'POST',
				body: 'x'.repeat(32)
			});
			expect(allowed.body.toString()).toBe('len:32');

			const rejected = await rawRequest(`${server.baseUrl}/upload`, {
				method: 'POST',
				body: 'x'.repeat(128)
			});
			expect(rejected.status).toBe(413);
		});

		it('shuts down gracefully on SIGTERM, finishing in-flight requests', async () => {
			const inflight = rawRequest(`${server.baseUrl}/slow`);
			await new Promise((resolve) => setTimeout(resolve, 200));

			const exitCode = await server.shutdown('SIGTERM');
			const response = await inflight;

			expect(response.status).toBe(200);
			expect(response.body.toString()).toBe('slow-done');
			expect(exitCode).toBe(0);
			expect(server.stdout()).toContain('Server shut down (SIGTERM)');
		}, 30_000);
	});

	describe('envPrefix and runtimeConfig', () => {
		const prefixedOut = path.join(scratch, 'build-prefixed');
		let server: SpawnedServer;

		beforeAll(async () => {
			await adapter({
				out: prefixedOut,
				precompress: false,
				envPrefix: 'MY_APP_',
				runtimeConfig: { bodySizeLimit: 64 }
			}).adapt(fakeBuilder());
			// PORT must be ignored in favor of MY_APP_PORT; MY_APP_BODY_SIZE_LIMIT
			// must be ignored in favor of runtimeConfig.bodySizeLimit
			server = await spawnServer(
				path.join(prefixedOut, 'index.js'),
				{ PORT: '1', MY_APP_BODY_SIZE_LIMIT: '1024' },
				'MY_APP_PORT'
			);
		}, 120_000);

		afterAll(async () => {
			await server?.stop();
		});

		it('reads runtime configuration from prefixed variables only', async () => {
			expect(server.port).not.toBe(1);
			const response = await rawRequest(`${server.baseUrl}/hello`);
			expect(response.body.toString()).toBe('ssr:/hello');
		});

		it('lets runtimeConfig override runtime environment variables', async () => {
			const allowed = await rawRequest(`${server.baseUrl}/upload`, {
				method: 'POST',
				body: 'x'.repeat(32)
			});
			expect(allowed.body.toString()).toBe('len:32');

			// 128 bytes fits MY_APP_BODY_SIZE_LIMIT=1024 but not the baked-in 64
			const rejected = await rawRequest(`${server.baseUrl}/upload`, {
				method: 'POST',
				body: 'x'.repeat(128)
			});
			expect(rejected.status).toBe(413);
		});

		it('skips precompression when disabled', () => {
			expect(existsSync(path.join(prefixedOut, 'client/large.txt.gz'))).toBe(false);
		});
	});

	describe('runtimeConfig validation', () => {
		it('rejects unknown options at config time', () => {
			expect(() => adapter({ runtimeConfig: { nope: 'x' } as unknown as RuntimeConfig })).toThrow(
				/unknown 'runtimeConfig' option 'nope'/
			);
		});

		it('rejects values of the wrong shape at config time', () => {
			expect(() => adapter({ runtimeConfig: { port: 1.5 } })).toThrow(
				/invalid 'runtimeConfig\.port' value 1\.5 — expected an integer/
			);
			expect(() => adapter({ runtimeConfig: { port: 70_000 } })).toThrow(
				/invalid 'runtimeConfig\.port'/
			);
			expect(() => adapter({ runtimeConfig: { xffDepth: 0 } })).toThrow(
				/invalid 'runtimeConfig\.xffDepth' value 0 — expected a positive integer/
			);
			expect(() => adapter({ runtimeConfig: { bodySizeLimit: '10KB' } })).toThrow(
				/invalid 'runtimeConfig\.bodySizeLimit' value '10KB'/
			);
			expect(() => adapter({ runtimeConfig: { shutdownTimeout: -1 } })).toThrow(
				/invalid 'runtimeConfig\.shutdownTimeout'/
			);
			expect(() => adapter({ runtimeConfig: { host: 123 as unknown as string } })).toThrow(
				/invalid 'runtimeConfig\.host' value 123 — expected a string/
			);
		});

		it('accepts documented value shapes', () => {
			expect(() =>
				adapter({
					runtimeConfig: {
						port: 0,
						host: '127.0.0.1',
						bodySizeLimit: '1M',
						idleTimeout: 60,
						xffDepth: 2
					}
				})
			).not.toThrow();
			expect(() => adapter({ runtimeConfig: { bodySizeLimit: Infinity } })).not.toThrow();
			expect(() => adapter({ runtimeConfig: { bodySizeLimit: 0 } })).not.toThrow();
		});
	});
});
