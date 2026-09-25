import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { writeAssetManifest } from '../../src/asset-manifest.js';

it('measures fresh-process handler startup for 100, 1000 and 10000 assets', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'adapter-startup-'));
	const source = process.env.PERF_BUILD_DIR ?? path.resolve('../../examples/app/build');
	const baseline = process.env.PERF_BASELINE === 'true';
	const results: Record<string, unknown> = {};
	try {
		for (const count of [100, 1000, 10000]) {
			const build = path.join(root, String(count));
			cpSync(source, build, { recursive: true });
			writeFileSync(path.join(build, 'package.json'), '{"type":"module"}');
			rmSync(path.join(build, 'client'), { recursive: true, force: true });
			mkdirSync(path.join(build, 'client/_app/immutable'), { recursive: true });
			for (let i = 0; i < count; i++)
				writeFileSync(path.join(build, `client/_app/immutable/${i}.js`), `export const x = ${i};`);
			await writeAssetManifest(build);
			const samples = [];
			for (let trial = 0; trial < 7; trial++) {
				const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let stats = 0, reads = 0;
const stat = fs.statSync, read = fs.readdirSync;
fs.statSync = (...args) => { stats++; return stat(...args); };
fs.readdirSync = (...args) => { reads++; return read(...args); };
syncBuiltinESMExports();
global.gc();
const heap = process.memoryUsage().heapUsed;
const start = performance.now();
await import(${JSON.stringify(pathToFileURL(path.join(build, 'handler.js')).href)});
const ms = performance.now() - start;
global.gc();
console.log(JSON.stringify({ ms, stats, reads, heapBytes: process.memoryUsage().heapUsed - heap }));`;
				const sample = JSON.parse(
					execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
						encoding: 'utf8'
					})
				);
				if (!baseline) {
					expect(sample.stats).toBe(0);
					expect(sample.reads).toBe(0);
				}
				samples.push(sample);
			}
			results[count] = {
				manifestBytes: statSync(path.join(build, 'asset-manifest.js')).size,
				samples
			};
		}
		console.log('[startup]', JSON.stringify(results));
		if (process.env.PERF_OUTPUT)
			writeFileSync(process.env.PERF_OUTPUT + '-startup.json', JSON.stringify(results, null, 2));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
