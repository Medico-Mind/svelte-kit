import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_COMPRESS_EXTENSIONS,
	compressDirectory,
	detectZstd,
	resolvePrecompressOptions
} from '../../src/compress.js';

const BIG = 'compressible text, repeated over and over. '.repeat(100); // ~4.3 KB
const zstdSupported = detectZstd() !== null;

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
		const result = await compressDirectory(dir, ALL, { warn: () => {} });

		for (const file of ['page.html', 'nested/app.js']) {
			const original = readFileSync(path.join(dir, file));
			expect(zlib.gunzipSync(readFileSync(path.join(dir, `${file}.gz`)))).toEqual(original);
			expect(zlib.brotliDecompressSync(readFileSync(path.join(dir, `${file}.br`)))).toEqual(
				original
			);
			if (zstdSupported) {
				const zstdDecompress = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer })
					.zstdDecompressSync;
				expect(zstdDecompress(readFileSync(path.join(dir, `${file}.zst`)))).toEqual(original);
			}
		}

		const expectedPerFile = zstdSupported ? 3 : 2;
		expect(result.written).toHaveLength(2 * expectedPerFile);
		expect(result.zstdSkipped).toBe(!zstdSupported);
	});

	it('sidecars are smaller than the source for compressible input', async () => {
		await compressDirectory(dir, ALL, { warn: () => {} });
		const original = readFileSync(path.join(dir, 'page.html')).byteLength;
		expect(readFileSync(path.join(dir, 'page.html.gz')).byteLength).toBeLessThan(original);
		expect(readFileSync(path.join(dir, 'page.html.br')).byteLength).toBeLessThan(original);
	});

	it('skips files below the size threshold', async () => {
		await compressDirectory(dir, ALL, { warn: () => {} });
		expect(existsSync(path.join(dir, 'tiny.css.gz'))).toBe(false);
	});

	it('skips files outside the extension allowlist', async () => {
		await compressDirectory(dir, ALL, { warn: () => {} });
		expect(existsSync(path.join(dir, 'image.png.gz'))).toBe(false);
	});

	it('honors a custom size threshold', async () => {
		await compressDirectory(dir, ALL, { warn: () => {}, minSize: 1 });
		expect(existsSync(path.join(dir, 'tiny.css.gz'))).toBe(true);
	});

	it('respects per-encoding toggles', async () => {
		const gzipOnly = resolvePrecompressOptions({ brotli: false, zstd: false })!;
		await compressDirectory(dir, gzipOnly, { warn: () => {} });
		expect(existsSync(path.join(dir, 'page.html.gz'))).toBe(true);
		expect(existsSync(path.join(dir, 'page.html.br'))).toBe(false);
		expect(existsSync(path.join(dir, 'page.html.zst'))).toBe(false);
	});

	it('does not re-compress existing sidecars', async () => {
		await compressDirectory(dir, ALL, { warn: () => {} });
		await compressDirectory(dir, ALL, { warn: () => {} });
		expect(existsSync(path.join(dir, 'page.html.gz.gz'))).toBe(false);
		expect(existsSync(path.join(dir, 'page.html.br.gz'))).toBe(false);
	});

	it('warns and skips zstd when unsupported instead of failing', async () => {
		const warn = vi.fn();
		const result = await compressDirectory(dir, ALL, { warn, createZstd: null });

		expect(result.zstdSkipped).toBe(true);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toMatch(/zstd/);
		expect(existsSync(path.join(dir, 'page.html.zst'))).toBe(false);
		expect(existsSync(path.join(dir, 'page.html.gz'))).toBe(true);
	});

	it('uses an injected zstd factory', async () => {
		const result = await compressDirectory(dir, ALL, {
			warn: () => {},
			createZstd: () => new PassThrough()
		});
		expect(result.zstdSkipped).toBe(false);
		expect(readFileSync(path.join(dir, 'page.html.zst')).toString()).toBe(BIG);
	});

	it('returns an empty result for a missing directory', async () => {
		const result = await compressDirectory(path.join(dir, 'does-not-exist'), ALL, {
			warn: () => {}
		});
		expect(result.written).toEqual([]);
	});

	it('does nothing when every encoding is toggled off', async () => {
		const none = resolvePrecompressOptions({ gzip: false, brotli: false, zstd: false })!;
		const result = await compressDirectory(dir, none, { warn: () => {} });
		expect(result.written).toEqual([]);
		expect(result.zstdSkipped).toBe(false);
	});

	it('bounds concurrency without dropping work', async () => {
		const result = await compressDirectory(dir, ALL, { warn: () => {}, concurrency: 1 });
		expect(result.written.length).toBeGreaterThan(0);
	});
});
