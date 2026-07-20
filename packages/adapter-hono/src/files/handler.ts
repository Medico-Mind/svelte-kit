import 'SHIMS';

import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { env } from 'ENV';
import { manifest, prerendered } from 'MANIFEST';
import { Server } from 'SERVER';

import { buildHonoApp } from '../runtime/app.js';
import { parseBodySizeLimit, parseBooleanEnv } from '../runtime/env-core.js';

/** Root of the emitted build output (this file's directory). */
const dir = path.dirname(fileURLToPath(import.meta.url));

const server = new Server(manifest);
await server.init({
	env: process.env as Record<string, string>,
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

const clientRoot = path.join(dir, 'client');
const prerenderedRoot = path.join(dir, 'prerendered');

/**
 * The composable Hono app serving this SvelteKit build:
 * static assets → prerendered pages → SSR.
 *
 * Mount it inside your own Hono server via `app.route('/', app)`.
 */
export const app = buildHonoApp({
	client: existsSync(clientRoot)
		? { root: clientRoot, immutablePathPrefix: `/${manifest.appPath}/immutable/` }
		: undefined,
	prerendered: existsSync(prerenderedRoot)
		? { root: prerenderedRoot, prerenderedPaths: prerendered }
		: undefined,
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
