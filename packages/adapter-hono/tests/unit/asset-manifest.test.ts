import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { afterEach, expect, it } from 'vitest';

import { createAssetManifest, writeAssetManifest } from '../../src/asset-manifest.js';
import { buildHonoApp } from '../../src/runtime/app.js';
import type { AssetManifest } from '../../src/runtime/assets.js';

const roots: string[] = [];
const temporary = () => {
	const root = mkdtempSync(path.join(tmpdir(), 'asset-manifest-'));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('hashes exact content, independent of location, timestamps and traversal order', async () => {
	const root = temporary();
	writeFileSync(path.join(root, 'first.txt'), 'same');
	const first = (await createAssetManifest(root)).get('/first.txt')!;
	utimesSync(path.join(root, 'first.txt'), 100, 100);
	writeFileSync(path.join(root, 'aaa.txt'), 'same');
	const again = await createAssetManifest(root);
	expect(again.get('/first.txt')!.etag).toBe(first.etag);
	expect(again.get('/aaa.txt')!.etag).toBe(first.etag);
	writeFileSync(path.join(root, 'first.txt'), 'diff');
	utimesSync(path.join(root, 'first.txt'), 100, 100);
	expect((await createAssetManifest(root)).get('/first.txt')!.etag).not.toBe(first.etag);
	const other = temporary();
	writeFileSync(path.join(other, 'moved.txt'), 'same');
	expect((await createAssetManifest(other)).get('/moved.txt')!.etag).toBe(first.etag);
});

it('hashes sidecar bytes independently, even when identity content stays unchanged', async () => {
	const root = temporary();
	const content = 'compress me '.repeat(1000);
	writeFileSync(path.join(root, 'data.txt'), content);
	writeFileSync(path.join(root, 'data.txt.gz'), zlib.gzipSync(content, { level: 1 }));
	const first = (await createAssetManifest(root)).get('/data.txt')!;
	const nextBytes = zlib.gzipSync(content, { level: 9 });
	writeFileSync(path.join(root, 'data.txt.gz'), nextBytes);
	const second = (await createAssetManifest(root)).get('/data.txt')!;
	expect(first.etag).toBe(second.etag);
	expect(first.encodings.get('gzip')!.etag).not.toBe(second.encodings.get('gzip')!.etag);
	expect(second.encodings.get('gzip')!.etag).toBe(
		`"${createHash('sha256').update(nextBytes).digest('base64url')}"`
	);
});

it('excludes symlink files and directories and accepts absent asset directories', async () => {
	const root = temporary();
	const outside = temporary();
	writeFileSync(path.join(outside, 'secret.txt'), 'secret');
	symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
	symlinkSync(outside, path.join(root, 'linked-dir'));
	expect((await createAssetManifest(root)).size).toBe(0);
	expect((await createAssetManifest(path.join(root, 'absent'))).size).toBe(0);
	await writeAssetManifest(root);
	expect(readFileSync(path.join(root, 'asset-manifest.js'), 'utf8')).toContain(
		"assets('./client', [])"
	);
});

it('emits deterministic, relocatable metadata and preserves unusual pathnames and base paths', async () => {
	const root = temporary();
	const client = path.join(root, 'client/base/nested');
	mkdirSync(client, { recursive: true });
	mkdirSync(path.join(root, 'prerendered/base'), { recursive: true });
	for (const name of ['юникод space.txt', 'percent%23#?.txt', 'slash.txt'])
		writeFileSync(path.join(client, name), name);
	writeFileSync(path.join(client, 'slash.txt.br'), zlib.brotliCompressSync('slash.txt'));
	writeFileSync(path.join(root, 'prerendered/base/about.html'), '<html>about</html>');
	await writeAssetManifest(root);
	const generated = readFileSync(path.join(root, 'asset-manifest.js'), 'utf8');
	expect(generated).not.toContain(root);
	await writeAssetManifest(root);
	expect(readFileSync(path.join(root, 'asset-manifest.js'), 'utf8')).toBe(generated);
	const moved = temporary();
	cpSync(root, moved, { recursive: true });
	rmSync(root, { recursive: true, force: true });
	const manifest = (await import(pathToFileURL(path.join(moved, 'asset-manifest.js')).href)) as {
		client: AssetManifest;
		prerendered: AssetManifest;
	};
	const app = buildHonoApp({
		client: { manifest: manifest.client },
		prerendered: { manifest: manifest.prerendered },
		ssr: () => new Response('missing', { status: 404 })
	});
	for (const name of ['юникод space.txt', 'percent%23#?.txt', 'slash.txt']) {
		const response = await app.request('/base/nested/' + encodeURIComponent(name) + '?q=ignored');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(name);
	}
	expect(await (await app.request('/base%2Fnested%2Fslash.txt')).text()).toBe('slash.txt');
	expect(await (await app.request('/base/about')).text()).toBe('<html>about</html>');
	const encoded = await app.request('/base/nested/slash.txt', {
		headers: { 'accept-encoding': 'br' }
	});
	expect(zlib.brotliDecompressSync(Buffer.from(await encoded.arrayBuffer())).toString()).toBe(
		'slash.txt'
	);
	for (const url of [
		'/../../etc/passwd',
		'/%2e%2e/%2e%2e/etc/passwd',
		'/base/nested/%2e%2e%2f%2e%2e%2fsecret',
		'/%E0%A4%A',
		'/bad%',
		'/base/nested/slash.txt%00'
	]) {
		expect((await app.request(url)).status, url).toBe(404);
	}
	writeFileSync(path.join(moved, 'client/late.txt'), 'not in manifest');
	expect((await app.request('/late.txt')).status).toBe(404);
});
