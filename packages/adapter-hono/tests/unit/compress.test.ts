import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_COMPRESS_EXTENSIONS,
	compressDirectory,
	resolvePrecompressOptions
} from '../../src/compress.js';

const BIG = 'compressible text, repeated over and over. '.repeat(100); // ~4.3 KB

const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer })
	.zstdDecompressSync;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'adapter-hono-compress-'));
	mkdirSync(path.join(dir, 'nested'), { recursive: true });
	writeFileSync(path.join(dir, 'page.html'), BIG);
	writeFileSync(path.join(dir, 'nested/app.js'), BIG);
	writeFileSync(path.join(dir, 'tiny.css'), 'a{}'); // below min size
	writeFileSync(path.join(dir, 'image.png'), Buffer.alloc(4096, 7)); // not in allowlist
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ALL = resolvePrecompressOptions(true)!;

describe('resolvePrecompressOptions', () => {
	it('disables precompression for false/undefined', () => {
		expect(resolvePrecompressOptions(false)).toBeNull();
		expect(resolvePrecompressOptions(undefined)).toBeNull();
	});

	it('enables everything for true', () => {
		expect(ALL.brotli).toBe(true);
		expect(ALL.gzip).toBe(true);
		expect(ALL.zstd).toBe(true);
		expect([...ALL.extensions].sort()).toEqual([...DEFAULT_COMPRESS_EXTENSIONS].sort());
	});

	it('honors per-encoding toggles and a custom allowlist', () => {
		const resolved = resolvePrecompressOptions({ brotli: false, files: ['CSS', 'js'] })!;
		expect(resolved.brotli).toBe(false);
		expect(resolved.gzip).toBe(true);
		expect(resolved.zstd).toBe(true);
		expect([...resolved.extensions].sort()).toEqual(['css', 'js']);
	});
});

describe('compressDirectory', () => {
	it('produces sidecars that decompress to identical bytes', async () => {
		const result = await compressDirectory(dir, ALL);

		for (const file of ['page.html', 'nested/app.js']) {
			const original = readFileSync(path.join(dir, file));
			expect(zlib.gunzipSync(readFileSync(path.join(dir, `${file}.gz`)))).toEqual(original);
			expect(zlib.brotliDecompressSync(readFileSync(path.join(dir, `${file}.br`)))).toEqual(
				original
			);
			expect(zstdDecompressSync(readFileSync(path.join(dir, `${file}.zst`)))).toEqual(original);
		}

		expect(result.written).toHaveLength(2 * 3);
	});

	it('sidecars are smaller than the source for compressible input', async () => {
		await compressDirectory(dir, ALL);
		const original = readFileSync(path.join(dir, 'page.html')).byteLength;
		expect(readFileSync(path.join(dir, 'page.html.gz')).byteLength).toBeLessThan(original);
		expect(readFileSync(path.join(dir, 'page.html.br')).byteLength).toBeLessThan(original);
	});

	it('leaves the original files untouched', async () => {
		await compressDirectory(dir, ALL);
		expect(readFileSync(path.join(dir, 'page.html'), 'utf8')).toBe(BIG);
		expect(existsSync(path.join(dir, 'adapter-hono-precompress-entry'))).toBe(false);
	});

	it('skips files below the size threshold', async () => {
		await compressDirectory(dir, ALL);
		expect(existsSync(path.join(dir, 'tiny.css.gz'))).toBe(false);
	});

	it('skips files outside the extension allowlist', async () => {
		await compressDirectory(dir, ALL);
		expect(existsSync(path.join(dir, 'image.png.gz'))).toBe(false);
	});

	it('honors a custom size threshold', async () => {
		await compressDirectory(dir, ALL, { minSize: 1 });
		expect(existsSync(path.join(dir, 'tiny.css.gz'))).toBe(true);
	});

	it('respects per-encoding toggles', async () => {
		const gzipOnly = resolvePrecompressOptions({ brotli: false, zstd: false })!;
		await compressDirectory(dir, gzipOnly);
		expect(existsSync(path.join(dir, 'page.html.gz'))).toBe(true);
		expect(existsSync(path.join(dir, 'page.html.br'))).toBe(false);
		expect(existsSync(path.join(dir, 'page.html.zst'))).toBe(false);
	});

	it('does not re-compress existing sidecars', async () => {
		await compressDirectory(dir, ALL);
		await compressDirectory(dir, ALL);
		expect(existsSync(path.join(dir, 'page.html.gz.gz'))).toBe(false);
		expect(existsSync(path.join(dir, 'page.html.br.gz'))).toBe(false);
	});

	it('returns an empty result for a missing directory', async () => {
		const result = await compressDirectory(path.join(dir, 'does-not-exist'), ALL);
		expect(result.written).toEqual([]);
	});

	it('does nothing when every encoding is toggled off', async () => {
		const none = resolvePrecompressOptions({ gzip: false, brotli: false, zstd: false })!;
		const result = await compressDirectory(dir, none);
		expect(result.written).toEqual([]);
	});

	it('does nothing for an empty extension allowlist', async () => {
		const result = await compressDirectory(dir, resolvePrecompressOptions({ files: [] })!);
		expect(result.written).toEqual([]);
	});

	it('bounds concurrency without dropping work', async () => {
		const result = await compressDirectory(dir, ALL, { concurrency: 1 });
		expect(result.written.length).toBeGreaterThan(0);
	});
});
