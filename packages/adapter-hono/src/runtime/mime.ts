/**
 * Minimal extension → content-type map for the static file server.
 *
 * Kept dependency-free on purpose; unknown extensions fall back to
 * `application/octet-stream`.
 */
const TYPES: Record<string, string> = {
	html: 'text/html;charset=utf-8',
	htm: 'text/html;charset=utf-8',
	js: 'text/javascript;charset=utf-8',
	mjs: 'text/javascript;charset=utf-8',
	css: 'text/css;charset=utf-8',
	json: 'application/json;charset=utf-8',
	map: 'application/json;charset=utf-8',
	txt: 'text/plain;charset=utf-8',
	xml: 'application/xml;charset=utf-8',
	svg: 'image/svg+xml;charset=utf-8',
	webmanifest: 'application/manifest+json;charset=utf-8',
	wasm: 'application/wasm',
	ico: 'image/x-icon',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	eot: 'application/vnd.ms-fontobject',
	mp3: 'audio/mpeg',
	ogg: 'audio/ogg',
	mp4: 'video/mp4',
	webm: 'video/webm',
	pdf: 'application/pdf',
	zip: 'application/zip',
	gz: 'application/gzip',
	br: 'application/octet-stream',
	zst: 'application/octet-stream'
};

/**
 * Returns the `content-type` for a pathname based on its file extension.
 */
export function contentType(pathname: string): string {
	const dot = pathname.lastIndexOf('.');
	const ext = dot === -1 ? '' : pathname.slice(dot + 1).toLowerCase();
	return TYPES[ext] ?? 'application/octet-stream';
}
