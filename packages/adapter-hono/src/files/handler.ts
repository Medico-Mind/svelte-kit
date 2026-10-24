import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { client, prerendered as prerenderedAssets } from 'ASSETS';
import { env } from 'ENV';
import { appPath, prerendered } from 'MANIFEST';
import { server } from 'SERVER';

import { buildHonoApp } from '../runtime/app.js';
import { parseBodySizeLimit, parseBooleanEnv } from '../runtime/env-core.js';

/** Root of the emitted build output (this file's directory). */
const dir = path.dirname(fileURLToPath(import.meta.url));

await server.init({
	env: process.env,
	read: (file) =>
		Readable.toWeb(createReadStream(path.join(dir, 'server', file))) as ReadableStream<Uint8Array>
});

function headerEnv(name: string): string | undefined {
	return env(name, '').toLowerCase() || undefined;
}

const xffDepth = Number(env('XFF_DEPTH', '1'));
if (!Number.isInteger(xffDepth) || xffDepth < 1) {
	throw new Error(`XFF_DEPTH must be a positive integer, got '${env('XFF_DEPTH', '1')}'`);
}

/**
 * The composable Hono app serving this SvelteKit build:
 * static assets → prerendered pages → SSR.
 *
 * Mount it inside your own Hono server via `app.route('/', app)`.
 */
export const app = buildHonoApp({
	client: { manifest: client, immutablePathPrefix: `/${appPath}/immutable/` },
	prerendered: { manifest: prerenderedAssets, prerenderedPaths: prerendered },
	ssr: (request, context) => server.respond(request, context),
	compressOnDemand: parseBooleanEnv(env('COMPRESS_ON_DEMAND', 'false')),
	origin: env('ORIGIN'),
	protocolHeader: headerEnv('PROTOCOL_HEADER'),
	hostHeader: headerEnv('HOST_HEADER'),
	portHeader: headerEnv('PORT_HEADER'),
	addressHeader: headerEnv('ADDRESS_HEADER'),
	xffDepth,
	bodySizeLimit: parseBodySizeLimit(env('BODY_SIZE_LIMIT', '512K')),
	getSocketAddress: (c) =>
		(c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
			?.remoteAddress
});

/**
 * Fetch-style entry point: `(request: Request) => Promise<Response>`.
 * Useful for embedding in any environment that speaks `fetch`.
 */
export const handler: (request: Request) => Promise<Response> = async (request) =>
	app.fetch(request);
