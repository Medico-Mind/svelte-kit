import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Adapter, Builder } from '@sveltejs/kit';
import { rolldown, type InputOptions } from 'rolldown';

import {
	compressDirectory,
	resolvePrecompressOptions,
	type PrecompressOptions
} from './compress.js';
import { parseBodySizeLimit, type RuntimeEnvVar } from './runtime/env-core.js';

export { DEFAULT_COMPRESS_EXTENSIONS, type PrecompressOptions } from './compress.js';

/**
 * Runtime configuration fixed at build time.
 *
 * Every field maps to a runtime environment variable. By default the emitted
 * server reads its configuration from the environment; a field set here is
 * baked into the build and **takes precedence over the corresponding
 * environment variable** at runtime. Unset fields keep being read from the
 * environment (honoring `envPrefix`).
 */
export interface RuntimeConfig {
	/**
	 * Port to listen on; `0` picks a random ephemeral port.
	 * Overrides the `PORT` environment variable (default `3000`).
	 */
	port?: number;
	/**
	 * Interface to bind.
	 * Overrides the `HOST` environment variable (default `'0.0.0.0'`).
	 */
	host?: string;
	/**
	 * Unix domain socket path to listen on; wins over `port`/`host` when set.
	 * Overrides the `SOCKET_PATH` environment variable.
	 */
	socketPath?: string;
	/**
	 * Public origin of the app, e.g. `'https://example.com'`. Wins over the
	 * proxy header fields below.
	 * Overrides the `ORIGIN` environment variable.
	 */
	origin?: string;
	/**
	 * Header carrying the original protocol behind a proxy, e.g.
	 * `'x-forwarded-proto'`.
	 * Overrides the `PROTOCOL_HEADER` environment variable.
	 */
	protocolHeader?: string;
	/**
	 * Header carrying the original host behind a proxy, e.g.
	 * `'x-forwarded-host'`.
	 * Overrides the `HOST_HEADER` environment variable.
	 */
	hostHeader?: string;
	/**
	 * Header carrying the original port behind a proxy, e.g.
	 * `'x-forwarded-port'`.
	 * Overrides the `PORT_HEADER` environment variable.
	 */
	portHeader?: string;
	/**
	 * Header to read the client IP from, e.g. `'x-forwarded-for'`. Only
	 * configure headers your proxy overwrites.
	 * Overrides the `ADDRESS_HEADER` environment variable.
	 */
	addressHeader?: string;
	/**
	 * With `addressHeader: 'x-forwarded-for'`: how many proxies deep to look,
	 * counting from the right of the header. Positive integer.
	 * Overrides the `XFF_DEPTH` environment variable (default `1`).
	 */
	xffDepth?: number;
	/**
	 * Max request body size — a number of bytes, a string with an optional
	 * `K`/`M`/`G` suffix (`'512K'`, `'1M'`), or `Infinity`. Both `0` and
	 * `Infinity` disable the limit. Exceeding requests get a 413.
	 * Overrides the `BODY_SIZE_LIMIT` environment variable (default `'512K'`).
	 */
	bodySizeLimit?: number | string;
	/**
	 * Seconds to wait for in-flight requests after `SIGINT`/`SIGTERM` before
	 * force-closing sockets.
	 * Overrides the `SHUTDOWN_TIMEOUT` environment variable (default `30`).
	 */
	shutdownTimeout?: number;
	/**
	 * If > 0: gracefully shut down after this many seconds without in-flight
	 * requests; `0` disables.
	 * Overrides the `IDLE_TIMEOUT` environment variable (default `0`).
	 */
	idleTimeout?: number;
}

/** Options for the `@medicomind/svelte-adapter-hono` adapter factory. */
export interface AdapterOptions {
	/** Output directory for the standalone build. Default `'build'`. */
	out?: string;
	/**
	 * Precompress static assets and prerendered pages into `.gz`/`.br`/`.zst`
	 * sidecars served via `Accept-Encoding` negotiation. `true` (the default)
	 * enables all encodings; an object toggles them individually.
	 */
	precompress?: boolean | PrecompressOptions;
	/** Prefix for the runtime environment variables (`PORT`, `HOST`, …). Default `''`. */
	envPrefix?: string;
	/**
	 * Runtime configuration fixed at build time. Every field defaults to its
	 * runtime environment variable; a field set here is baked into the build
	 * and takes precedence over that variable at runtime.
	 */
	runtimeConfig?: RuntimeConfig;
}

const TEMPLATE_FILES = ['index.js', 'handler.js', 'app.js', 'env.js', 'shims.js'] as const;

function templateDirectory(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// dist/index.js sits next to dist/files; when running from src (tests), fall back to dist
	for (const candidate of [path.join(here, 'files'), path.join(here, '..', 'dist', 'files')]) {
		if (existsSync(path.join(candidate, 'handler.js'))) return candidate;
	}
	throw new Error(
		'@medicomind/svelte-adapter-hono: runtime templates not found — the package build (tsup) has not produced dist/files'
	);
}

/** Rewrites quoted placeholder import specifiers and the ENV_PREFIX/ENV_OVERRIDES tokens. */
function instantiateTemplate(
	content: string,
	specifiers: Record<string, string>,
	envPrefix: string,
	envOverrides: Record<string, string>
): string {
	let out = content.replaceAll('ENV_PREFIX', JSON.stringify(envPrefix));
	for (const [token, value] of Object.entries(specifiers)) {
		out = out
			.replaceAll(`"${token}"`, JSON.stringify(value))
			.replaceAll(`'${token}'`, JSON.stringify(value));
	}
	// last, so user-provided values can never collide with the tokens above
	return out.replaceAll('ENV_OVERRIDES', JSON.stringify(envOverrides));
}

const isString = (value: unknown): boolean => typeof value === 'string';
const isSeconds = (value: unknown): boolean =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isBodySizeLimit = (value: unknown): boolean => {
	if (typeof value === 'number') return value >= 0; // includes Infinity, excludes NaN
	if (typeof value !== 'string') return false;
	try {
		parseBodySizeLimit(value);
		return true;
	} catch {
		return false;
	}
};

/** Per-field environment variable mapping and validation for `runtimeConfig`. */
const RUNTIME_CONFIG_FIELDS: Record<
	keyof RuntimeConfig,
	{ envVar: RuntimeEnvVar; expected: string; ok: (value: unknown) => boolean }
> = {
	port: {
		envVar: 'PORT',
		expected: 'an integer between 0 and 65535',
		ok: (value) =>
			typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
	},
	host: { envVar: 'HOST', expected: 'a string', ok: isString },
	socketPath: { envVar: 'SOCKET_PATH', expected: 'a string', ok: isString },
	origin: { envVar: 'ORIGIN', expected: 'a string', ok: isString },
	protocolHeader: { envVar: 'PROTOCOL_HEADER', expected: 'a string', ok: isString },
	hostHeader: { envVar: 'HOST_HEADER', expected: 'a string', ok: isString },
	portHeader: { envVar: 'PORT_HEADER', expected: 'a string', ok: isString },
	addressHeader: { envVar: 'ADDRESS_HEADER', expected: 'a string', ok: isString },
	xffDepth: {
		envVar: 'XFF_DEPTH',
		expected: 'a positive integer',
		ok: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1
	},
	bodySizeLimit: {
		envVar: 'BODY_SIZE_LIMIT',
		expected:
			"a non-negative number of bytes, a string with an optional K/M/G suffix, or 'Infinity'",
		ok: isBodySizeLimit
	},
	shutdownTimeout: {
		envVar: 'SHUTDOWN_TIMEOUT',
		expected: 'a non-negative number of seconds',
		ok: isSeconds
	},
	idleTimeout: {
		envVar: 'IDLE_TIMEOUT',
		expected: 'a non-negative number of seconds',
		ok: isSeconds
	}
};

/**
 * Validates `runtimeConfig` and maps it onto the environment variable names
 * baked into the emitted `env.js`.
 */
function resolveRuntimeConfig(config: RuntimeConfig): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const [key, value] of Object.entries(config)) {
		const field = RUNTIME_CONFIG_FIELDS[key as keyof RuntimeConfig] as
			(typeof RUNTIME_CONFIG_FIELDS)[keyof RuntimeConfig] | undefined;
		if (!field) {
			throw new Error(
				`@medicomind/svelte-adapter-hono: unknown 'runtimeConfig' option '${key}'. Known options: ${Object.keys(RUNTIME_CONFIG_FIELDS).join(', ')}`
			);
		}
		if (value === undefined) continue;
		if (!field.ok(value)) {
			const shown = typeof value === 'string' ? `'${value}'` : String(value);
			throw new Error(
				`@medicomind/svelte-adapter-hono: invalid 'runtimeConfig.${key}' value ${shown} — expected ${field.expected}`
			);
		}
		overrides[field.envVar] = String(value);
	}
	return overrides;
}

/** Copies non-JS server assets (used by `read()` from `$app/server`) into the output. */
function copyServerAssets(from: string, to: string): void {
	if (!existsSync(from)) return;
	for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		if (/\.(js|mjs|cjs|map)$/.test(entry.name)) continue;
		const source = path.join(entry.parentPath, entry.name);
		const destination = path.join(to, path.relative(from, source));
		mkdirSync(path.dirname(destination), { recursive: true });
		copyFileSync(source, destination);
	}
}

/**
 * Creates a SvelteKit adapter that emits a self-contained Node server powered
 * by Hono (`hono` + `@hono/node-server`), with optional brotli/gzip/zstd
 * precompression of static assets and prerendered pages.
 *
 * @example
 * ```js
 * // svelte.config.js
 * import adapter from '@medicomind/svelte-adapter-hono';
 *
 * export default {
 *   kit: {
 *     adapter: adapter({
 *       out: 'build',
 *       precompress: true,
 *       envPrefix: '',
 *       runtimeConfig: { bodySizeLimit: '1M' }
 *     })
 *   }
 * };
 * ```
 */
export default function adapter(options: AdapterOptions = {}): Adapter {
	const { out = 'build', precompress = true, envPrefix = '', runtimeConfig = {} } = options;
	const envOverrides = resolveRuntimeConfig(runtimeConfig);

	return {
		name: '@medicomind/svelte-adapter-hono',

		async adapt(builder: Builder) {
			const tmp = builder.getBuildDirectory('adapter-hono');

			builder.rimraf(out);
			builder.rimraf(tmp);
			builder.mkdirp(tmp);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

			const resolvedPrecompress = resolvePrecompressOptions(precompress);
			if (resolvedPrecompress) {
				builder.log.minor('Compressing assets');
				for (const dir of [`${out}/client`, `${out}/prerendered`]) {
					await compressDirectory(dir, resolvedPrecompress);
				}
			}

			builder.log.minor('Building server');
			builder.writeServer(`${tmp}/server`);

			writeFileSync(
				`${tmp}/manifest.js`,
				`export const manifest = ${builder.generateManifest({ relativePath: './server' })};\n\n` +
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n\n` +
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};\n`
			);

			const templates = templateDirectory();
			const specifiers = {
				SHIMS: './shims.js',
				SERVER: './server/index.js',
				MANIFEST: './server/manifest.js',
				ENV: './env.js',
				HANDLER: './handler.js'
			};
			for (const name of TEMPLATE_FILES) {
				const content = readFileSync(path.join(templates, name), 'utf8');
				writeFileSync(
					path.join(tmp, name),
					instantiateTemplate(content, specifiers, envPrefix, envOverrides)
				);
			}

			const onLog: NonNullable<InputOptions['onLog']> = (level, log, defaultHandler) => {
				if (log.code === 'CIRCULAR_DEPENDENCY' || log.code === 'THIS_IS_UNDEFINED') {
					return;
				}
				defaultHandler(level, log);
			};
			const isBuiltin = (id: string) => id.startsWith('node:') || builtinModules.includes(id);

			// Pass 1: the SvelteKit server (with the app's server-side dependencies
			// and dynamic route imports) is bundled into out/server.
			builder.log.minor('Bundling SvelteKit server');
			const serverBundle = await rolldown({
				input: {
					index: `${tmp}/server/index.js`,
					manifest: `${tmp}/manifest.js`
				},
				external: isBuiltin,
				platform: 'node',
				preserveEntrySignatures: 'exports-only',
				onLog
			});
			await serverBundle.write({
				dir: `${out}/server`,
				format: 'esm',
				sourcemap: true,
				entryFileNames: '[name].js',
				chunkFileNames: 'chunks/[name]-[hash].js'
			});
			await serverBundle.close();

			// Pass 2: each runtime template becomes exactly one file at the output
			// root — a single-entry rolldown build without code splitting keeps
			// relative imports between the emitted modules verbatim and handler.js'
			// import.meta.url-based lookup of client/ and prerendered/ stays correct.
			builder.log.minor('Bundling server entry');
			const tmpDir = path.resolve(tmp);
			const crossModuleImport =
				/^\.\/(handler|app|env|shims)\.js$|^\.\/server\/(index|manifest)\.js$/;
			for (const name of TEMPLATE_FILES) {
				const templateBundle = await rolldown({
					input: path.join(tmp, name),
					external: (id, importer) => {
						if (isBuiltin(id)) return true;
						return (
							crossModuleImport.test(id) &&
							importer !== undefined &&
							path.dirname(path.resolve(importer)) === tmpDir
						);
					},
					// keep './handler.js' & co. verbatim in the output
					makeAbsoluteExternalsRelative: false,
					platform: 'node',
					preserveEntrySignatures: 'exports-only',
					onLog
				});
				await templateBundle.write({
					file: path.join(out, name),
					format: 'esm',
					sourcemap: true,
					codeSplitting: false
				});
				await templateBundle.close();
			}

			// asset files referenced by `read()` from `$app/server`
			copyServerAssets(`${tmp}/server`, `${out}/server`);

			builder.log.success(`Wrote standalone Hono server to ${out}`);
		},

		supports: {
			read: () => true
		}
	};
}
