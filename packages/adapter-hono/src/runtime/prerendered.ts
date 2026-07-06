import type { AssetEntry, AssetManifest } from './assets.js';

/**
 * Looks up the file that serves a prerendered page for `pathname`.
 *
 * SvelteKit writes prerendered pages as `<path>.html` or `<path>/index.html`
 * (depending on `trailingSlash`) and prerendered endpoints at their exact
 * path, so all three shapes are tried.
 */
export function lookupPrerendered(
	manifest: AssetManifest,
	pathname: string
): AssetEntry | undefined {
	if (pathname.endsWith('/')) {
		return (
			manifest.get(`${pathname}index.html`) ??
			(pathname.length > 1 ? manifest.get(`${pathname.slice(0, -1)}.html`) : undefined)
		);
	}
	return (
		manifest.get(pathname) ??
		manifest.get(`${pathname}.html`) ??
		manifest.get(`${pathname}/index.html`)
	);
}

/**
 * When `pathname` itself is not prerendered but the variant with the opposite
 * trailing slash is, returns that variant so the caller can issue a 308
 * redirect (mirroring `adapter-node`).
 */
export function trailingSlashRedirect(
	prerenderedPaths: ReadonlySet<string>,
	pathname: string
): string | undefined {
	if (prerenderedPaths.has(pathname)) return undefined;
	const toggled = pathname.endsWith('/') ? pathname.slice(0, -1) : `${pathname}/`;
	return toggled && prerenderedPaths.has(toggled) ? toggled : undefined;
}
