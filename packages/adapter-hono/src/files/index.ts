import type { Server as HttpServer } from 'node:http';

import { createAdaptorServer } from '@hono/node-server';

import { env, prefix } from 'ENV';
import { app } from 'HANDLER';

import { manageServerLifecycle } from '../runtime/lifecycle.js';

function numberEnv(name: string, fallback: string): number {
	const raw = env(name, fallback);
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`${prefix}${name} must be a number, got '${raw}'`);
	}
	return value;
}

const socketPath = env('SOCKET_PATH');
const host = env('HOST', '0.0.0.0');
const port = numberEnv('PORT', '3000');
const shutdownTimeout = numberEnv('SHUTDOWN_TIMEOUT', '30');
const idleTimeout = numberEnv('IDLE_TIMEOUT', '0');

/** The underlying `node:http` server, exported for programmatic use. */
export const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer;

manageServerLifecycle(server, {
	shutdownTimeoutSeconds: shutdownTimeout,
	idleTimeoutSeconds: idleTimeout,
	onShutdown: (reason) => console.log(`Server shut down (${reason})`)
});

if (socketPath) {
	server.listen(socketPath, () => {
		console.log(`Listening on ${socketPath}`);
	});
} else {
	server.listen(port, host, () => {
		const address = server.address();
		const actualPort = typeof address === 'object' && address !== null ? address.port : port;
		console.log(`Listening on http://${host}:${actualPort}`);
	});
}
