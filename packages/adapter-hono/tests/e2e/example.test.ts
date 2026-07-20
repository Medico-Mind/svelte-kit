import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rawRequest, spawnServer, type SpawnedServer } from '../helpers/http.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = path.resolve(pkgDir, '..', '..', 'examples', 'app');
const buildDir = path.join(exampleDir, 'build');

function findFile(dir: string, predicate: (file: string) => boolean): string | undefined {
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && predicate(entry.name)) return path.join(entry.parentPath, entry.name);
	}
	return undefined;
}

beforeAll(() => {
	// vite build of the example app, using this package via the workspace link
	execFileSync('npm', ['run', 'build'], { cwd: exampleDir, stdio: 'inherit' });
	expect(existsSync(path.join(buildDir, 'index.js'))).toBe(true);
}, 300_000);

describe('build output', () => {
	it('contains client, prerendered and server entry files', () => {
		for (const file of ['index.js', 'handler.js', 'app.js', 'env.js', 'shims.js']) {
			expect(existsSync(path.join(buildDir, file)), file).toBe(true);
		}
		expect(existsSync(path.join(buildDir, 'client'))).toBe(true);
		expect(existsSync(path.join(buildDir, 'prerendered'))).toBe(true);
	});

	it('generated .gz, .br and .zst sidecars for eligible assets', () => {
		const large = path.join(buildDir, 'client', 'large.txt');
		expect(existsSync(large)).toBe(true);
		expect(existsSync(`${large}.gz`)).toBe(true);
		expect(existsSync(`${large}.br`)).toBe(true);
		expect(existsSync(`${large}.zst`)).toBe(true);

		expect(existsSync(path.join(buildDir, 'client', 'small.txt.gz'))).toBe(false);

		const prerendered = findFile(path.join(buildDir, 'prerendered'), (f) => f === 'about.html');
		expect(prerendered).toBeDefined();
		expect(existsSync(`${prerendered}.gz`)).toBe(true);
	});
});

describe('emitted server (e2e)', () => {
	let server: SpawnedServer;
	const LARGE = () => readFileSync(path.join(buildDir, 'client', 'large.txt'));

	beforeAll(async () => {
		server = await spawnServer(path.join(buildDir, 'index.js'));
	}, 60_000);

	afterAll(async () => {
		await server?.stop();
	});

	it('serves the SSR route', async () => {
		const response = await rawRequest(`${server.baseUrl}/`);
		expect(response.status).toBe(200);
		expect(response.body.toString()).toContain('Hello from SSR');
		expect(response.body.toString()).toContain('ssr-marker-');
	});

	it('serves the prerendered page (from the prerendered dir, with negotiation)', async () => {
		const identity = await rawRequest(`${server.baseUrl}/about`);
		expect(identity.status).toBe(200);
		expect(identity.body.toString()).toContain('About — prerendered');

		// content-encoding proves the precompressed prerendered file was used
		const gzip = await rawRequest(`${server.baseUrl}/about`, {
			headers: { 'accept-encoding': 'gzip' }
		});
		expect(gzip.headers['content-encoding']).toBe('gzip');
		expect(zlib.gunzipSync(gzip.body).toString()).toContain('About — prerendered');
	});

	it('negotiates static asset encodings with correct bodies', async () => {
		const identity = await rawRequest(`${server.baseUrl}/large.txt`);
		expect(identity.headers['content-encoding']).toBeUndefined();
		expect(identity.body).toEqual(LARGE());

		const gzip = await rawRequest(`${server.baseUrl}/large.txt`, {
			headers: { 'accept-encoding': 'gzip' }
		});
		expect(gzip.headers['content-encoding']).toBe('gzip');
		expect(gzip.headers.vary).toBe('accept-encoding');
		expect(zlib.gunzipSync(gzip.body)).toEqual(LARGE());

		const brotli = await rawRequest(`${server.baseUrl}/large.txt`, {
			headers: { 'accept-encoding': 'br;q=0.9, gzip;q=0.8' }
		});
		expect(brotli.headers['content-encoding']).toBe('br');
		expect(zlib.brotliDecompressSync(brotli.body)).toEqual(LARGE());

		const preferred = await rawRequest(`${server.baseUrl}/large.txt`, {
			headers: { 'accept-encoding': 'zstd, br, gzip' }
		});
		expect(preferred.headers['content-encoding']).toBe('zstd');
		const zstdDecompress = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer })
			.zstdDecompressSync;
		expect(zstdDecompress(preferred.body)).toEqual(LARGE());
	});

	it('serves immutable assets with immutable cache headers', async () => {
		const immutableDir = path.join(buildDir, 'client', '_app', 'immutable');
		const file = findFile(immutableDir, (f) => f.endsWith('.js'));
		expect(file).toBeDefined();

		const pathname = `/${path.relative(path.join(buildDir, 'client'), file!).split(path.sep).join('/')}`;
		const response = await rawRequest(`${server.baseUrl}${pathname}`);
		expect(response.status).toBe(200);
		expect(response.headers['cache-control']).toBe('public, immutable, max-age=31536000');
	});

	it('returns 404 (SvelteKit error page) for unknown routes', async () => {
		const response = await rawRequest(`${server.baseUrl}/definitely/not/here`);
		expect(response.status).toBe(404);
	});

	it('enforces the default BODY_SIZE_LIMIT (512K)', async () => {
		const allowed = await rawRequest(`${server.baseUrl}/echo`, {
			method: 'POST',
			body: Buffer.alloc(10 * 1024, 1)
		});
		expect(allowed.status).toBe(200);
		expect(allowed.body.toString()).toBe(String(10 * 1024));

		const rejected = await rawRequest(`${server.baseUrl}/echo`, {
			method: 'POST',
			body: Buffer.alloc(600 * 1024, 1)
		});
		expect(rejected.status).toBe(413);
	});

	it('reports a client address', async () => {
		const response = await rawRequest(`${server.baseUrl}/ip`);
		expect(response.status).toBe(200);
		expect(response.body.toString().length).toBeGreaterThan(0);
	});

	it('does not compress SSR responses by default', async () => {
		const response = await rawRequest(`${server.baseUrl}/`, {
			headers: { 'accept-encoding': 'gzip, br, zstd' }
		});
		expect(response.status).toBe(200);
		expect(response.headers['content-encoding']).toBeUndefined();
	});

	it('compresses SSR responses on the fly with COMPRESS_ON_DEMAND=true', async () => {
		const dedicated = await spawnServer(path.join(buildDir, 'index.js'), {
			COMPRESS_ON_DEMAND: 'true'
		});
		try {
			const gzip = await rawRequest(`${dedicated.baseUrl}/`, {
				headers: { 'accept-encoding': 'gzip' }
			});
			expect(gzip.status).toBe(200);
			expect(gzip.headers['content-encoding']).toBe('gzip');
			expect(gzip.headers.vary).toBe('accept-encoding');
			expect(gzip.headers['content-length']).toBeUndefined();
			expect(zlib.gunzipSync(gzip.body).toString()).toContain('Hello from SSR');

			// precompressed sidecars still win over on-the-fly compression
			const sidecar = await rawRequest(`${dedicated.baseUrl}/large.txt`, {
				headers: { 'accept-encoding': 'gzip' }
			});
			expect(sidecar.headers['content-encoding']).toBe('gzip');
			expect(sidecar.headers['content-length']).toBeDefined();
			expect(zlib.gunzipSync(sidecar.body)).toEqual(LARGE());
		} finally {
			await dedicated.stop();
		}
	}, 60_000);

	it('finishes in-flight requests on SIGTERM and exits cleanly', async () => {
		const dedicated = await spawnServer(path.join(buildDir, 'index.js'));
		const inflight = rawRequest(`${dedicated.baseUrl}/slow`);
		await new Promise((resolve) => setTimeout(resolve, 300));

		const exitCode = await dedicated.shutdown('SIGTERM');
		const response = await inflight;

		expect(response.status).toBe(200);
		expect(response.body.toString()).toBe('slow-done');
		expect(exitCode).toBe(0);
	}, 60_000);
});

describe('embedding the built app', () => {
	it('mounts inside a user-owned Hono server and exposes a fetch-style handler', async () => {
		const module = (await import(pathToFileURL(path.join(buildDir, 'app.js')).href)) as {
			app: Hono;
			handler: (request: Request) => Promise<Response>;
		};

		const root = new Hono();
		root.get('/custom', (c) => c.text('user-route'));
		root.route('/', module.app);

		expect(await (await root.request('/custom')).text()).toBe('user-route');

		const prerendered = await root.request('/about');
		expect(prerendered.status).toBe(200);
		expect(await prerendered.text()).toContain('About — prerendered');

		const ssr = await root.request('/');
		expect(ssr.status).toBe(200);
		expect(await ssr.text()).toContain('Hello from SSR');

		const viaHandler = await module.handler(new Request('http://localhost/about'));
		expect(viaHandler.status).toBe(200);
	});
});
