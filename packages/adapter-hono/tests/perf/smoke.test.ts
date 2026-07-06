import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import autocannon from 'autocannon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnServer, type SpawnedServer } from '../helpers/http.js';

/**
 * Non-gating performance smoke test (CI runs it with continue-on-error):
 * hammers the static and SSR routes and asserts no errored/non-2xx responses
 * under load. Requires the example app to be built (`tests/e2e` does that).
 */
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = path.resolve(pkgDir, '..', '..', 'examples', 'app', 'build');
const built = existsSync(path.join(buildDir, 'index.js'));

describe.skipIf(!built)('performance smoke', () => {
	let server: SpawnedServer;

	beforeAll(async () => {
		server = await spawnServer(path.join(buildDir, 'index.js'));
	}, 60_000);

	afterAll(async () => {
		await server?.stop();
	});

	const scenarios = [
		{ name: 'static asset', path: '/large.txt' },
		{ name: 'static asset (gzip)', path: '/large.txt', headers: { 'accept-encoding': 'gzip' } },
		{ name: 'SSR route', path: '/' }
	];

	for (const scenario of scenarios) {
		it(`${scenario.name} serves without errors under load`, async () => {
			const result = await autocannon({
				url: `${server.baseUrl}${scenario.path}`,
				headers: scenario.headers,
				connections: 25,
				pipelining: 1,
				duration: 3
			});

			console.log(
				`[perf] ${scenario.name}: ${Math.round(result.requests.average)} req/s, ` +
					`p99 ${result.latency.p99}ms, errors ${result.errors}, non-2xx ${result.non2xx}`
			);

			expect(result.errors).toBe(0);
			expect(result.non2xx).toBe(0);
			expect(result.requests.average).toBeGreaterThan(0);
		}, 30_000);
	}
});
