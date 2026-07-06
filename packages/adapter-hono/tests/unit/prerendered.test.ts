import { describe, expect, it } from 'vitest';

import type { AssetEntry, AssetManifest } from '../../src/runtime/assets.js';
import { lookupPrerendered, trailingSlashRedirect } from '../../src/runtime/prerendered.js';

function manifestOf(...pathnames: string[]): AssetManifest {
	const manifest: AssetManifest = new Map();
	for (const pathname of pathnames) {
		manifest.set(pathname, {
			pathname,
			filePath: `/fake${pathname}`,
			size: 1,
			mtime: new Date(0),
			etag: 'x',
			encodings: new Map()
		} satisfies AssetEntry);
	}
	return manifest;
}

describe('lookupPrerendered', () => {
	const manifest = manifestOf(
		'/index.html',
		'/about.html',
		'/docs/index.html',
		'/data.json',
		'/mixed.html',
		'/mixed/index.html'
	);

	it('resolves the root to /index.html', () => {
		expect(lookupPrerendered(manifest, '/')?.pathname).toBe('/index.html');
	});

	it('resolves extensionless paths to <path>.html then <path>/index.html', () => {
		expect(lookupPrerendered(manifest, '/about')?.pathname).toBe('/about.html');
		expect(lookupPrerendered(manifest, '/docs')?.pathname).toBe('/docs/index.html');
		expect(lookupPrerendered(manifest, '/mixed')?.pathname).toBe('/mixed.html');
	});

	it('resolves trailing-slash paths to <path>/index.html then <path>.html', () => {
		expect(lookupPrerendered(manifest, '/docs/')?.pathname).toBe('/docs/index.html');
		expect(lookupPrerendered(manifest, '/about/')?.pathname).toBe('/about.html');
	});

	it('resolves exact file paths (prerendered endpoints)', () => {
		expect(lookupPrerendered(manifest, '/data.json')?.pathname).toBe('/data.json');
	});

	it('returns undefined for unknown paths', () => {
		expect(lookupPrerendered(manifest, '/nope')).toBeUndefined();
		expect(lookupPrerendered(manifest, '/nope/')).toBeUndefined();
	});
});

describe('trailingSlashRedirect', () => {
	const paths = new Set(['/about', '/docs/']);

	it('suggests the opposite-slash variant when prerendered', () => {
		expect(trailingSlashRedirect(paths, '/about/')).toBe('/about');
		expect(trailingSlashRedirect(paths, '/docs')).toBe('/docs/');
	});

	it('returns undefined when the path itself is prerendered', () => {
		expect(trailingSlashRedirect(paths, '/about')).toBeUndefined();
		expect(trailingSlashRedirect(paths, '/docs/')).toBeUndefined();
	});

	it('returns undefined when neither variant is prerendered', () => {
		expect(trailingSlashRedirect(paths, '/other')).toBeUndefined();
	});

	it('never redirects the root to an empty path', () => {
		expect(trailingSlashRedirect(new Set(['']), '/')).toBeUndefined();
	});
});
