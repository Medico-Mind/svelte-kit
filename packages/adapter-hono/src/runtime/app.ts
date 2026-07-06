import { Hono, type Context } from 'hono';

import { resolveClientAddress, validateXffDepth } from './address.js';
import { createAssetManifest, serveAsset } from './assets.js';
import { lookupPrerendered, trailingSlashRedirect } from './prerendered.js';
import { BodySizeLimitError, prepareSsrRequest, type SsrRequestConfig } from './request.js';

/** Context passed to the SSR handler alongside the request. */
export interface SsrContext {
	/** Resolves the client IP, honoring `ADDRESS_HEADER`/`XFF_DEPTH`. */
	getClientAddress(): string;
}

/** SSR entry point — `Server.respond()` from `@sveltejs/kit` fits this shape. */
export type SsrHandler = (request: Request, context: SsrContext) => Response | Promise<Response>;

/** Options for {@link buildHonoApp}. All file lookups are resolved once at construction. */
export interface BuildAppOptions extends SsrRequestConfig {
	/** Renders non-static routes; typically `Server.respond` from `@sveltejs/kit`. */
	ssr: SsrHandler;
	/** Static client assets directory (`build/client`). */
	client?: {
		root: string;
		/** Pathname prefix (e.g. `/_app/immutable/`) that gets immutable cache headers. */
		immutablePathPrefix?: string;
	};
	/** Prerendered pages directory (`build/prerendered`). */
	prerendered?: {
		root: string;
		/** Prerendered route paths from the SvelteKit manifest, used for trailing-slash redirects. */
		prerenderedPaths?: ReadonlySet<string>;
	};
	/** Lowercased header to resolve the client IP from (e.g. `x-forwarded-for`). */
	addressHeader?: string | undefined;
	/** `x-forwarded-for` depth, counted from the right. Default 1. */
	xffDepth?: number | undefined;
	/** Fallback client address source — the TCP socket peer when running under `@hono/node-server`. */
	getSocketAddress?: (c: Context) => string | undefined;
}

const IMMUTABLE_CACHE_CONTROL = 'public, immutable, max-age=31536000';
const MUTABLE_CACHE_CONTROL = 'no-cache';

/** Decodes a request URL's pathname; returns `undefined` when malformed. */
function decodedPathname(c: Context): string | undefined {
	try {
		return decodeURIComponent(new URL(c.req.url).pathname);
	} catch {
		return undefined;
	}
}

function isReadMethod(method: string): boolean {
	return method === 'GET' || method === 'HEAD';
}

/**
 * Builds the composable Hono app: static assets → prerendered pages → SSR.
 *
 * The returned app can be served directly (`@hono/node-server`), mounted into
 * a larger Hono app via `app.route()`, or driven through `app.fetch` /
 * `app.request` in tests.
 */
export function buildHonoApp(options: BuildAppOptions): Hono {
	if (options.xffDepth !== undefined) validateXffDepth(options.xffDepth);

	const app = new Hono();

	if (options.client) {
		const manifest = createAssetManifest(options.client.root);
		const immutablePrefix = options.client.immutablePathPrefix;

		app.use(async (c, next) => {
			if (!isReadMethod(c.req.method)) return next();
			const pathname = decodedPathname(c);
			const entry = pathname === undefined ? undefined : manifest.get(pathname);
			if (!entry) return next();

			const immutable = immutablePrefix !== undefined && entry.pathname.startsWith(immutablePrefix);
			return serveAsset(c.req.raw, entry, {
				cacheControl: immutable ? IMMUTABLE_CACHE_CONTROL : MUTABLE_CACHE_CONTROL
			});
		});
	}

	if (options.prerendered) {
		const manifest = createAssetManifest(options.prerendered.root);
		const prerenderedPaths = options.prerendered.prerenderedPaths ?? new Set<string>();

		app.use(async (c, next) => {
			if (!isReadMethod(c.req.method)) return next();
			const pathname = decodedPathname(c);
			if (pathname === undefined) return next();

			// the canonical trailing-slash variant wins over a direct file hit
			const redirect = trailingSlashRedirect(prerenderedPaths, pathname);
			if (redirect) {
				const location = redirect + new URL(c.req.url).search;
				return new Response(null, { status: 308, headers: { location } });
			}

			const entry = lookupPrerendered(manifest, pathname);
			if (entry) return serveAsset(c.req.raw, entry);

			return next();
		});
	}

	const addressConfig = { addressHeader: options.addressHeader, xffDepth: options.xffDepth };

	app.all('*', async (c) => {
		const prepared = prepareSsrRequest(c.req.raw, options);
		if (prepared instanceof Response) return prepared;

		try {
			return await options.ssr(prepared, {
				getClientAddress: () =>
					resolveClientAddress(prepared.headers, addressConfig, () => options.getSocketAddress?.(c))
			});
		} catch (error) {
			// a chunked body that exceeded BODY_SIZE_LIMIT while SSR was reading it
			if (error instanceof BodySizeLimitError) {
				return new Response(error.message, { status: 413 });
			}
			throw error;
		}
	});

	return app;
}
