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

import commonjsPlugin from '@rollup/plugin-commonjs';
import jsonPlugin from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import type { Adapter, Builder } from '@sveltejs/kit';
import { rollup } from 'rollup';

/** CJS/ESM interop for rollup plugins whose types confuse NodeNext resolution. */
function interopDefault<T>(module: T): T extends { default: infer F } ? F : T {
	return ((module as { default?: unknown }).default ?? module) as T extends { default: infer F }
		? F
		: T;
}

const commonjs = interopDefault(commonjsPlugin);
const json = interopDefault(jsonPlugin);

import {
	compressDirectory,
	resolvePrecompressOptions,
	type PrecompressOptions
} from './compress.js';

export { DEFAULT_COMPRESS_EXTENSIONS, type PrecompressOptions } from './compress.js';

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

/** Rewrites quoted placeholder import specifiers and the ENV_PREFIX token. */
function instantiateTemplate(
	content: string,
	specifiers: Record<string, string>,
	envPrefix: string
): string {
	let out = content.replaceAll('ENV_PREFIX', JSON.stringify(envPrefix));
	for (const [token, value] of Object.entries(specifiers)) {
		out = out
			.replaceAll(`"${token}"`, JSON.stringify(value))
			.replaceAll(`'${token}'`, JSON.stringify(value));
	}
	return out;
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
 *     adapter: adapter({ out: 'build', precompress: true, envPrefix: '' })
 *   }
 * };
 * ```
 */
export default function adapter(options: AdapterOptions = {}): Adapter {
	const { out = 'build', precompress = true, envPrefix = '' } = options;

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
					await compressDirectory(dir, resolvedPrecompress, {
						warn: (message) => builder.log.warn(message)
					});
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
				writeFileSync(path.join(tmp, name), instantiateTemplate(content, specifiers, envPrefix));
			}

			const plugins = () => [
				nodeResolve({ preferBuiltins: true, exportConditions: ['node', 'import', 'default'] }),
				commonjs(),
				json()
			];
			const onwarn: NonNullable<Parameters<typeof rollup>[0]['onwarn']> = (warning, warn) => {
				if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'THIS_IS_UNDEFINED') {
					return;
				}
				warn(warning);
			};
			const isBuiltin = (id: string) => id.startsWith('node:') || builtinModules.includes(id);

			// Pass 1: the SvelteKit server (with the app's server-side dependencies
			// and dynamic route imports) is bundled into out/server.
			builder.log.minor('Bundling SvelteKit server');
			const serverBundle = await rollup({
				input: {
					index: `${tmp}/server/index.js`,
					manifest: `${tmp}/manifest.js`
				},
				external: isBuiltin,
				plugins: plugins(),
				preserveEntrySignatures: 'exports-only',
				onwarn
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
			// root — a single-entry rollup build cannot be code-split, so relative
			// imports between the emitted modules stay verbatim and handler.js'
			// import.meta.url-based lookup of client/ and prerendered/ stays correct.
			builder.log.minor('Bundling server entry');
			const tmpDir = path.resolve(tmp);
			const crossModuleImport =
				/^\.\/(handler|app|env|shims)\.js$|^\.\/server\/(index|manifest)\.js$/;
			for (const name of TEMPLATE_FILES) {
				const templateBundle = await rollup({
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
					plugins: plugins(),
					preserveEntrySignatures: 'exports-only',
					onwarn
				});
				await templateBundle.write({
					file: path.join(out, name),
					format: 'esm',
					sourcemap: true,
					inlineDynamicImports: true
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
