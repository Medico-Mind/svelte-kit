import type { Server as HttpServer } from 'node:http';

export interface LifecycleOptions {
	/** Seconds to wait for in-flight requests before force-closing sockets. Default 30. */
	shutdownTimeoutSeconds?: number;
	/** Shut down after this many seconds without in-flight requests. `0` (default) disables. */
	idleTimeoutSeconds?: number;
	/** Signals that trigger graceful shutdown. Default `['SIGINT', 'SIGTERM']`. */
	signals?: NodeJS.Signals[];
	/** Called once the server has fully closed. */
	onShutdown?: (reason: string) => void;
}

export interface LifecycleHandle {
	/** Begins graceful shutdown (idempotent). */
	shutdown(reason: string): void;
	isShuttingDown(): boolean;
	activeRequests(): number;
}

/**
 * Attaches graceful-shutdown and idle-timeout behavior to an HTTP server.
 *
 * On shutdown the server stops accepting connections, idle keep-alive
 * connections are closed immediately, in-flight requests get up to
 * `shutdownTimeoutSeconds` to finish, then remaining sockets are destroyed.
 * Once fully closed, a `sveltekit:shutdown` event is emitted on `process`
 * with the trigger reason (`SIGINT`, `SIGTERM` or `IDLE`).
 */
export function manageServerLifecycle(
	server: HttpServer,
	options: LifecycleOptions = {}
): LifecycleHandle {
	const shutdownTimeout = options.shutdownTimeoutSeconds ?? 30;
	const idleTimeout = options.idleTimeoutSeconds ?? 0;
	const signals = options.signals ?? ['SIGINT', 'SIGTERM'];

	let active = 0;
	let lastActivity = Date.now();
	let shuttingDown = false;

	server.on('request', (_req, res) => {
		active += 1;
		lastActivity = Date.now();
		res.on('close', () => {
			active -= 1;
			lastActivity = Date.now();
			// keep-alive sockets that just went idle would otherwise stall close()
			if (shuttingDown) server.closeIdleConnections();
		});
	});

	let idleInterval: NodeJS.Timeout | undefined;
	if (idleTimeout > 0) {
		idleInterval = setInterval(() => {
			if (!shuttingDown && active === 0 && Date.now() - lastActivity >= idleTimeout * 1000) {
				shutdown('IDLE');
			}
		}, 250);
		idleInterval.unref();
	}

	const signalHandlers = new Map<NodeJS.Signals, () => void>(
		signals.map((signal) => [signal, () => shutdown(signal)])
	);

	function shutdown(reason: string): void {
		if (shuttingDown) return;
		shuttingDown = true;

		if (idleInterval) clearInterval(idleInterval);
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);

		const force = setTimeout(() => server.closeAllConnections(), shutdownTimeout * 1000);
		force.unref();

		server.close(() => {
			clearTimeout(force);
			options.onShutdown?.(reason);
			(process.emit as (event: string, ...args: unknown[]) => boolean)(
				'sveltekit:shutdown',
				reason
			);
		});
		server.closeIdleConnections();
	}

	for (const [signal, handler] of signalHandlers) process.on(signal, handler);

	return {
		shutdown,
		isShuttingDown: () => shuttingDown,
		activeRequests: () => active
	};
}
