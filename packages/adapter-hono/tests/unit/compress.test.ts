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

	it('enables everything at the default levels for true', () => {
		expect(ALL.brotli).toEqual({ quality: 11, windowBits: undefined, sectionSize: undefined });
		expect(ALL.gzip).toEqual({ level: 9 });
		expect(ALL.zstd).toEqual({ level: 19 });
		expect([...ALL.extensions].sort()).toEqual([...DEFAULT_COMPRESS_EXTENSIONS].sort());
	});

	it('honors per-encoding toggles and a custom allowlist', () => {
		const resolved = resolvePrecompressOptions({ brotli: false, files: ['CSS', 'js'] })!;
		expect(resolved.brotli).toBeNull();
		expect(resolved.gzip).toEqual({ level: 9 });
		expect(resolved.zstd).toEqual({ level: 19 });
		expect([...resolved.extensions].sort()).toEqual(['css', 'js']);
	});

	it('accepts per-encoding option objects', () => {
		const resolved = resolvePrecompressOptions({
			gzip: { level: 6 },
			brotli: { quality: 5, windowBits: 20, sectionSize: 262144 },
			zstd: { level: 3 }
		})!;
		expect(resolved.gzip).toEqual({ level: 6 });
		expect(resolved.brotli).toEqual({ quality: 5, windowBits: 20, sectionSize: 262144 });
		expect(resolved.zstd).toEqual({ level: 3 });
	});

	it('fills in defaults for omitted fields of an option object', () => {
		const resolved = resolvePrecompressOptions({ brotli: { windowBits: 24 }, gzip: {} })!;
		expect(resolved.brotli).toEqual({ quality: 11, windowBits: 24, sectionSize: undefined });
		expect(resolved.gzip).toEqual({ level: 9 });
	});

	it('rejects out-of-range levels', () => {
		expect(() => resolvePrecompressOptions({ gzip: { level: 10 } })).toThrow(
			/precompress\.gzip\.level/
		);
		expect(() => resolvePrecompressOptions({ brotli: { quality: 12 } })).toThrow(
			/precompress\.brotli\.quality/
		);
		expect(() => resolvePrecompressOptions({ brotli: { windowBits: 9 } })).toThrow(
			/precompress\.brotli\.windowBits/
		);
		expect(() => resolvePrecompressOptions({ brotli: { sectionSize: 0 } })).toThrow(
			/precompress\.brotli\.sectionSize/
		);
		expect(() => resolvePrecompressOptions({ zstd: { level: 0 } })).toThrow(
			/precompress\.zstd\.level/
		);
		expect(() => resolvePrecompressOptions({ gzip: { level: 1.5 } })).toThrow(
			/expected an integer between 0 and 9/
		);
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

	it('applies per-encoding levels', async () => {
		const low = resolvePrecompressOptions({ gzip: false, zstd: false, brotli: { quality: 0 } })!;
		await compressDirectory(dir, low);
		const cheap = readFileSync(path.join(dir, 'page.html.br'));
		expect(zlib.brotliDecompressSync(cheap)).toEqual(readFileSync(path.join(dir, 'page.html')));

		rmSync(path.join(dir, 'page.html.br'));
		await compressDirectory(dir, ALL);
		expect(readFileSync(path.join(dir, 'page.html.br')).byteLength).toBeLessThan(cheap.byteLength);
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
