import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { manageServerLifecycle } from '../../src/runtime/lifecycle.js';

const servers: Server[] = [];

function listen(
	handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; port: number }> {
	const server = createServer(handler);
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
		});
	});
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections?.();
		if (server.listening) await new Promise((resolve) => server.close(resolve));
	}
});

describe('manageServerLifecycle', () => {
	it('finishes in-flight requests before closing and emits sveltekit:shutdown', async () => {
		const { server, port } = await listen((_req, res) => {
			setTimeout(() => res.end('done'), 200);
		});

		const onShutdown = vi.fn();
		const shutdownEvent = vi.fn();
		process.once('sveltekit:shutdown' as unknown as NodeJS.Signals, shutdownEvent);

		const lifecycle = manageServerLifecycle(server, {
			signals: [],
			shutdownTimeoutSeconds: 5,
			onShutdown
		});

		const pending = fetch(`http://127.0.0.1:${port}/`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(lifecycle.activeRequests()).toBe(1);

		lifecycle.shutdown('TEST');
		expect(lifecycle.isShuttingDown()).toBe(true);

		const response = await pending;
		expect(await response.text()).toBe('done');

		await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith('TEST'));
		expect(shutdownEvent).toHaveBeenCalledWith('TEST');
		expect(server.listening).toBe(false);
	});

	it('is idempotent', async () => {
		const { server } = await listen((_req, res) => res.end('ok'));
		const onShutdown = vi.fn();
		const lifecycle = manageServerLifecycle(server, { signals: [], onShutdown });

		lifecycle.shutdown('ONE');
		lifecycle.shutdown('TWO');

		await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledOnce());
		expect(onShutdown).toHaveBeenCalledWith('ONE');
	});

	it('force-closes lingering connections after the shutdown timeout', async () => {
		const { server, port } = await listen(() => {
			/* never responds */
		});
		const onShutdown = vi.fn();
		const lifecycle = manageServerLifecycle(server, {
			signals: [],
			shutdownTimeoutSeconds: 0.2,
			onShutdown
		});

		const pending = fetch(`http://127.0.0.1:${port}/`).catch((error) => error);
		await new Promise((resolve) => setTimeout(resolve, 50));

		lifecycle.shutdown('FORCE');

		const result = await pending;
		expect(result).toBeInstanceOf(Error);
		await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith('FORCE'), { timeout: 3000 });
	});

	it('shuts down after the idle timeout elapses with no requests', async () => {
		const { server } = await listen((_req, res) => res.end('ok'));
		const onShutdown = vi.fn();
		manageServerLifecycle(server, {
			signals: [],
			idleTimeoutSeconds: 0.3,
			onShutdown
		});

		await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith('IDLE'), { timeout: 3000 });
	});

	it('does not idle-shutdown while requests are active', async () => {
		const { server, port } = await listen((_req, res) => {
			setTimeout(() => res.end('slow'), 700);
		});
		const onShutdown = vi.fn();
		manageServerLifecycle(server, {
			signals: [],
			idleTimeoutSeconds: 0.3,
			onShutdown
		});

		const response = await fetch(`http://127.0.0.1:${port}/`);
		expect(await response.text()).toBe('slow');
		expect(onShutdown).not.toHaveBeenCalled();
		// idle clock restarts after the request finishes
		await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith('IDLE'), { timeout: 3000 });
	});

	it('triggers on configured signals and deregisters its handlers afterwards', async () => {
		const { server } = await listen((_req, res) => res.end('ok'));
		const onShutdown = vi.fn();
		// SIGUSR2 keeps other SIGTERM/SIGINT listeners (e.g. the test runner's) out of the blast radius
		const before = process.listenerCount('SIGUSR2');

		manageServerLifecycle(server, { signals: ['SIGUSR2'], onShutdown });
		expect(process.listenerCount('SIGUSR2')).toBe(before + 1);

		process.emit('SIGUSR2');

		await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith('SIGUSR2'));
		expect(process.listenerCount('SIGUSR2')).toBe(before);
	});
});
