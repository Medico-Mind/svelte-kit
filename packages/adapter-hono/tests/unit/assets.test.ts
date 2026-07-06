import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	createAssetManifest,
	parseRangeHeader,
	serveAsset,
	type AssetManifest
} from '../../src/runtime/assets.js';

const CONTENT = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
const FAKE_ZSTD = Buffer.from('not-really-zstd-but-served-verbatim');

let root: string;
let manifest: AssetManifest;

const get = (pathname: string, headers: Record<string, string> = {}, method = 'GET') =>
	new Request(`http://localhost${pathname}`, { method, headers });

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), 'adapter-hono-assets-'));
	mkdirSync(path.join(root, 'nested'), { recursive: true });

	writeFileSync(path.join(root, 'hello.txt'), CONTENT);
	writeFileSync(path.join(root, 'hello.txt.gz'), zlib.gzipSync(CONTENT));
	writeFileSync(path.join(root, 'hello.txt.br'), zlib.brotliCompressSync(CONTENT));
	writeFileSync(path.join(root, 'hello.txt.zst'), FAKE_ZSTD);
	writeFileSync(path.join(root, 'plain.css'), 'body { color: red }');
	writeFileSync(path.join(root, 'nested/data.json'), '{"nested":true}');

	manifest = createAssetManifest(root);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('createAssetManifest', () => {
	it('indexes files by decoded pathname, including nested directories', () => {
		expect(manifest.get('/hello.txt')).toBeDefined();
		expect(manifest.get('/nested/data.json')).toBeDefined();
		expect(manifest.get('/missing.txt')).toBeUndefined();
	});

	it('attaches sidecar files as encoding variants of their base asset', () => {
		const entry = manifest.get('/hello.txt')!;
		expect([...entry.encodings.keys()].sort()).toEqual(['br', 'gzip', 'zstd']);
	});

	it('leaves files without sidecars encoding-free', () => {
		expect(manifest.get('/plain.css')!.encodings.size).toBe(0);
	});

	it('keeps sidecars directly addressable', () => {
		expect(manifest.get('/hello.txt.gz')).toBeDefined();
	});
});

describe('serveAsset — negotiation', () => {
	it('serves identity without accept-encoding', async () => {
		const response = serveAsset(get('/hello.txt'), manifest.get('/hello.txt')!);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-encoding')).toBeNull();
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(await response.text()).toBe(CONTENT);
	});

	it('serves the gzip sidecar with correct headers', async () => {
		const response = serveAsset(
			get('/hello.txt', { 'accept-encoding': 'gzip' }),
			manifest.get('/hello.txt')!
		);
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(response.headers.get('vary')).toBe('accept-encoding');
		const body = Buffer.from(await response.arrayBuffer());
		expect(zlib.gunzipSync(body).toString()).toBe(CONTENT);
		expect(Number(response.headers.get('content-length'))).toBe(body.byteLength);
	});

	it('prefers zstd on q-value ties and serves the sidecar bytes verbatim', async () => {
		const response = serveAsset(
			get('/hello.txt', { 'accept-encoding': 'gzip, br, zstd' }),
			manifest.get('/hello.txt')!
		);
		expect(response.headers.get('content-encoding')).toBe('zstd');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(FAKE_ZSTD);
	});

	it('sets vary even when identity is chosen for an asset with sidecars', () => {
		const response = serveAsset(get('/hello.txt'), manifest.get('/hello.txt')!);
		expect(response.headers.get('vary')).toBe('accept-encoding');
	});

	it('does not set vary for assets without sidecars', () => {
		const response = serveAsset(
			get('/plain.css', { 'accept-encoding': 'gzip' }),
			manifest.get('/plain.css')!
		);
		expect(response.headers.get('vary')).toBeNull();
		expect(response.headers.get('content-encoding')).toBeNull();
	});
});

describe('serveAsset — conditional requests', () => {
	it('returns 304 on a matching if-none-match, varying the etag by encoding', async () => {
		const first = serveAsset(
			get('/hello.txt', { 'accept-encoding': 'gzip' }),
			manifest.get('/hello.txt')!
		);
		const etag = first.headers.get('etag')!;
		expect(etag).toMatch(/^W\/".+-gzip"$/);

		const second = serveAsset(
			get('/hello.txt', { 'accept-encoding': 'gzip', 'if-none-match': etag }),
			manifest.get('/hello.txt')!
		);
		expect(second.status).toBe(304);
		expect(second.body).toBeNull();

		// identity etag differs, so no false 304 across encodings
		const identity = serveAsset(
			get('/hello.txt', { 'if-none-match': etag }),
			manifest.get('/hello.txt')!
		);
		expect(identity.status).toBe(200);
	});

	it('sends last-modified', () => {
		const response = serveAsset(get('/hello.txt'), manifest.get('/hello.txt')!);
		expect(response.headers.get('last-modified')).toBeTruthy();
	});
});

describe('serveAsset — range requests', () => {
	it('never negotiates encodings for range requests', async () => {
		const response = serveAsset(
			get('/hello.txt', { 'accept-encoding': 'gzip, br, zstd', range: 'bytes=0-8' }),
			manifest.get('/hello.txt')!
		);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-encoding')).toBeNull();
		expect(response.headers.get('content-range')).toBe(`bytes 0-8/${CONTENT.length}`);
		expect(await response.text()).toBe(CONTENT.slice(0, 9));
	});

	it('supports suffix ranges', async () => {
		const response = serveAsset(
			get('/hello.txt', { range: 'bytes=-4' }),
			manifest.get('/hello.txt')!
		);
		expect(response.status).toBe(206);
		expect(await response.text()).toBe(CONTENT.slice(-4));
	});

	it('responds 416 to unsatisfiable ranges', () => {
		const response = serveAsset(
			get('/hello.txt', { range: `bytes=${CONTENT.length + 10}-` }),
			manifest.get('/hello.txt')!
		);
		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe(`bytes */${CONTENT.length}`);
	});

	it('ignores malformed range headers and serves the full file', async () => {
		const response = serveAsset(
			get('/hello.txt', { range: 'bytes=1-2,5-6' }),
			manifest.get('/hello.txt')!
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(CONTENT);
	});
});

describe('serveAsset — HEAD', () => {
	it('sends headers without a body', () => {
		const response = serveAsset(
			get('/hello.txt', { 'accept-encoding': 'gzip' }, 'HEAD'),
			manifest.get('/hello.txt')!
		);
		expect(response.status).toBe(200);
		expect(response.body).toBeNull();
		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
	});
});

describe('parseRangeHeader', () => {
	it('parses bounded, open-ended and suffix ranges', () => {
		expect(parseRangeHeader('bytes=0-4', 100)).toEqual({ start: 0, end: 4 });
		expect(parseRangeHeader('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
		expect(parseRangeHeader('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
	});

	it('clamps the end to the file size', () => {
		expect(parseRangeHeader('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
	});

	it('clamps oversized suffixes to the whole file', () => {
		expect(parseRangeHeader('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
	});

	it('flags unsatisfiable ranges', () => {
		expect(parseRangeHeader('bytes=100-', 100)).toBe('unsatisfiable');
		expect(parseRangeHeader('bytes=50-10', 100)).toBe('unsatisfiable');
		expect(parseRangeHeader('bytes=-0', 100)).toBe('unsatisfiable');
	});

	it('rejects malformed and multi-range headers', () => {
		expect(parseRangeHeader('bytes=1-2,5-6', 100)).toBeUndefined();
		expect(parseRangeHeader('bytes=-', 100)).toBeUndefined();
		expect(parseRangeHeader('items=0-5', 100)).toBeUndefined();
	});
});
