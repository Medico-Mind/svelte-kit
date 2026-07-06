import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';

export interface RawResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

/**
 * Issues an HTTP request via `node:http` so responses arrive exactly as sent —
 * no transparent decompression like `fetch` performs.
 */
export function rawRequest(
	url: string,
	options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			url,
			// agent: false → a fresh connection per request; keep-alive reuse after
			// early responses (413 with an unread body) would poison later requests
			{ method: options.method ?? 'GET', headers: options.headers, agent: false },
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks)
					})
				);
				response.on('error', reject);
			}
		);
		request.on('error', reject);
		request.end(options.body);
	});
}

export interface SpawnedServer {
	proc: ChildProcess;
	port: number;
	baseUrl: string;
	stdout: () => string;
	stderr: () => string;
	/** SIGKILLs the process if still alive. */
	stop: () => Promise<void>;
	/** Sends a signal and waits for exit; returns the exit code. */
	shutdown: (signal?: NodeJS.Signals) => Promise<number | null>;
}

/**
 * Spawns `node <entry>` with `PORT=0` (unless overridden via `env`) and waits
 * for the `Listening on ...` line to learn the ephemeral port.
 */
export async function spawnServer(
	entry: string,
	env: Record<string, string> = {},
	portVar = 'PORT'
): Promise<SpawnedServer> {
	const proc = spawn(process.execPath, [entry], {
		env: { ...process.env, [portVar]: '0', ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stdout = '';
	let stderr = '';
	proc.stdout!.on('data', (chunk) => (stdout += chunk));
	proc.stderr!.on('data', (chunk) => (stderr += chunk));

	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`server did not start.\nstdout: ${stdout}\nstderr: ${stderr}`)),
			30_000
		);
		const check = () => {
			const match = /Listening on http:\/\/[^:]+:(\d+)/.exec(stdout);
			if (match) {
				clearTimeout(timer);
				resolve(Number(match[1]));
			}
		};
		proc.stdout!.on('data', check);
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
		});
	});

	return {
		proc,
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		stdout: () => stdout,
		stderr: () => stderr,
		stop: async () => {
			if (proc.exitCode === null && !proc.killed) {
				proc.kill('SIGKILL');
				await once(proc, 'exit');
			} else if (proc.exitCode === null) {
				await once(proc, 'exit');
			}
		},
		shutdown: async (signal = 'SIGTERM') => {
			if (proc.exitCode !== null) return proc.exitCode;
			proc.kill(signal);
			const [code] = (await once(proc, 'exit')) as [number | null];
			return code;
		}
	};
}
