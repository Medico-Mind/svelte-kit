import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { writeAssetManifest } from '../../src/asset-manifest.js';
import http from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rawRequest, spawnServer, type SpawnedServer } from '../helpers/http.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir =
	process.env.PERF_BUILD_DIR ?? path.resolve(pkgDir, '..', '..', 'examples', 'app', 'build');
const built = existsSync(path.join(buildDir, 'index.js'));

// Node's HTTP client correctly handles HEAD + Content-Length. Autocannon's
// response parser waits for a body in that case, making its HEAD numbers invalid.
async function measure(
	url: string,
	method: string,
	headers: Record<string, string>,
	status: number
) {
	const agent = new http.Agent({ keepAlive: true, maxSockets: 25 });
	const samples: number[] = [];
	let errors = 0;
	const request = () =>
		new Promise<void>((resolve) => {
			const start = performance.now();
			const req = http.request(url, { method, headers, agent }, (res) => {
				if (res.statusCode !== status) errors++;
				res.resume();
				res.on('end', () => {
					samples.push(performance.now() - start);
					resolve();
				});
				res.on('error', () => {
					errors++;
					resolve();
				});
			});
			req.on('error', () => {
				errors++;
				resolve();
			});
			req.setTimeout(5000, () => req.destroy(new Error('timeout')));
			req.end();
		});
	try {
		await Promise.all(
			Array.from({ length: 25 }, async () => {
				for (let i = 0; i < 20; i++) await request();
			})
		);
		samples.length = 0;
		const start = performance.now();
		await Promise.all(
			Array.from({ length: 25 }, async () => {
				while (performance.now() - start < 3000) await request();
			})
		);
		const elapsed = performance.now() - start;
		samples.sort((a, b) => a - b);
		return {
			requestsPerSecond: (samples.length * 1000) / elapsed,
			p99: samples[Math.floor(samples.length * 0.99)],
			errors
		};
	} finally {
		agent.destroy();
	}
}

describe.skipIf(!built)('performance smoke', () => {
	let server: SpawnedServer;
	const immutable = '/_app/immutable/perf-fixture.js';
	let scratch: string;
	let etag: string;
	const results: Record<string, unknown> = {};
	beforeAll(async () => {
		scratch = mkdtempSync(path.join(tmpdir(), 'adapter-request-perf-'));
		cpSync(buildDir, scratch, { recursive: true });
		writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}');
		const file = path.join(scratch, 'client', immutable);
		mkdirSync(path.dirname(file), { recursive: true });
		const bytes = Array.from({ length: 1024 }, (_, i) => `export const value${i} = ${i};`).join(
			'\n'
		);
		writeFileSync(file, bytes);
		writeFileSync(file + '.br', zlib.brotliCompressSync(bytes));
		writeFileSync(file + '.zst', zlib.zstdCompressSync(bytes));
		await writeAssetManifest(scratch);
		server = await spawnServer(path.join(scratch, 'index.js'));
		etag = (await rawRequest(server.baseUrl + immutable)).headers.etag!;
	});
	afterAll(async () => {
		await server?.stop();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		if (process.env.PERF_OUTPUT)
			writeFileSync(process.env.PERF_OUTPUT + '-requests.json', JSON.stringify(results, null, 2));
	});
	const scenarios = [
		{ name: 'immutable JS', headers: {} },
		{ name: 'immutable JS (br)', headers: { 'accept-encoding': 'br' } },
		{ name: 'immutable JS (zstd)', headers: { 'accept-encoding': 'zstd' } },
		{ name: 'HEAD immutable JS', method: 'HEAD', headers: {} },
		{ name: '304 If-None-Match', conditional: true, headers: {} },
		{ name: 'Range', headers: { range: 'bytes=0-100' } },
		{ name: 'SSR route', path: '/', headers: {} },
		{ name: 'API route', path: '/ip', headers: {} }
	];
	for (const scenario of scenarios) {
		it(scenario.name, async () => {
			const result = await measure(
				server.baseUrl + (scenario.path ?? immutable),
				scenario.method ?? 'GET',
				(scenario.conditional ? { 'if-none-match': etag } : scenario.headers) as Record<
					string,
					string
				>,
				scenario.conditional ? 304 : scenario.name === 'Range' ? 206 : 200
			);
			results[scenario.name] = result;
			console.log(`[perf] ${scenario.name}: ${JSON.stringify(result)}`);
			expect(result.errors).toBe(0);
			expect(result.requestsPerSecond).toBeGreaterThan(0);
		});
	}
});
