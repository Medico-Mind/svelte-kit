import { existsSync } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
	compression,
	defineAlgorithm,
	type DefineAlgorithmResult
} from '@medicomind/rolldown-compression';
import { rolldown, type InputOptions, type Plugin } from 'rolldown';

/**
 * Default extension allowlist for precompression (compressible text/code
 * formats emitted by SvelteKit builds).
 */
export const DEFAULT_COMPRESS_EXTENSIONS = [
	'html',
	'js',
	'json',
	'css',
	'svg',
	'xml',
	'wasm',
	'txt',
	'map',
	'ico',
	'webmanifest'
] as const;

/** Files smaller than this are not worth compressing. */
export const DEFAULT_MIN_COMPRESS_SIZE = 1024;

const SIDECAR_SUFFIXES = ['.gz', '.br', '.zst'];

/** Compression level defaults — maxed out, since precompression happens once at build time. */
export const DEFAULT_GZIP_LEVEL = 9;
export const DEFAULT_BROTLI_QUALITY = 11;
export const DEFAULT_ZSTD_LEVEL = 19;

/** Tuning for the `.gz` sidecars. */
export interface GzipPrecompressOptions {
	/** zlib compression level, `0`–`9`. Default {@link DEFAULT_GZIP_LEVEL}. */
	level?: number;
}

/** Tuning for the `.br` sidecars. */
export interface BrotliPrecompressOptions {
	/** Brotli quality, `0`–`11`. Default {@link DEFAULT_BROTLI_QUALITY}. */
	quality?: number;
	/** log2 of the brotli window size, `10`–`24`. Default `22` (the brotli default). */
	windowBits?: number;
	/**
	 * Target bytes per worker thread when a large input is split across the
	 * native brotli worker pool; inputs at least twice this size take the
	 * multithreaded path. Default 1 MiB. Smaller sections finish large files
	 * faster at a slight cost in compression ratio.
	 */
	sectionSize?: number;
}

/** Tuning for the `.zst` sidecars. */
export interface ZstdPrecompressOptions {
	/** zstd level, `1`–`22`. Default {@link DEFAULT_ZSTD_LEVEL}. */
	level?: number;
}

/**
 * `precompress` adapter option: `true` enables gzip + brotli + zstd with the
 * default extension allowlist; an object toggles encodings individually. Each
 * encoding accepts `true`/`false` or an options object that tunes it.
 */
export interface PrecompressOptions {
	/** Generate `.br` sidecars, optionally tuned. Default `true`. */
	brotli?: boolean | BrotliPrecompressOptions;
	/** Generate `.gz` sidecars, optionally tuned. Default `true`. */
	gzip?: boolean | GzipPrecompressOptions;
	/** Generate `.zst` sidecars, optionally tuned. Default `true`. */
	zstd?: boolean | ZstdPrecompressOptions;
	/** File extension allowlist (without dots). Defaults to {@link DEFAULT_COMPRESS_EXTENSIONS}. */
	files?: string[];
}

/**
 * Normalized shape of {@link PrecompressOptions}: each encoding is either its
 * fully-defaulted settings or `null` when disabled.
 */
export interface ResolvedPrecompressOptions {
	brotli: (BrotliPrecompressOptions & { quality: number }) | null;
	gzip: { level: number } | null;
	zstd: { level: number } | null;
	extensions: Set<string>;
}

function checkInteger(
	value: number | undefined,
	field: string,
	min: number,
	max: number
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(
			`@medicomind/svelte-adapter-hono: invalid 'precompress.${field}' value ${String(value)} — expected an integer between ${min} and ${max}`
		);
	}
	return value;
}

/** `false` disables the encoding; `true`/`undefined` mean "enabled with defaults". */
function resolveEncoding<Options extends object, Resolved>(
	value: boolean | Options | undefined,
	resolve: (options: Options) => Resolved
): Resolved | null {
	if (value === false) return null;
	return resolve(value === undefined || value === true ? ({} as Options) : value);
}

/**
 * Normalizes the `precompress` option. Returns `null` when precompression is
 * disabled entirely. Throws on out-of-range levels so a typo fails at config
 * time rather than mid-build.
 */
export function resolvePrecompressOptions(
	precompress: boolean | PrecompressOptions | undefined
): ResolvedPrecompressOptions | null {
	if (!precompress) return null;
	const object = precompress === true ? {} : precompress;
	return {
		brotli: resolveEncoding(object.brotli, (options: BrotliPrecompressOptions) => ({
			quality: checkInteger(options.quality, 'brotli.quality', 0, 11) ?? DEFAULT_BROTLI_QUALITY,
			windowBits: checkInteger(options.windowBits, 'brotli.windowBits', 10, 24),
			sectionSize: checkInteger(options.sectionSize, 'brotli.sectionSize', 1, 0xffffffff)
		})),
		gzip: resolveEncoding(object.gzip, (options: GzipPrecompressOptions) => ({
			level: checkInteger(options.level, 'gzip.level', 0, 9) ?? DEFAULT_GZIP_LEVEL
		})),
		zstd: resolveEncoding(object.zstd, (options: ZstdPrecompressOptions) => ({
			level: checkInteger(options.level, 'zstd.level', 1, 22) ?? DEFAULT_ZSTD_LEVEL
		})),
		extensions: new Set(
			(object.files ?? DEFAULT_COMPRESS_EXTENSIONS).map((ext) => ext.toLowerCase())
		)
	};
}

export interface CompressDirectoryExtras {
	/** Minimum file size in bytes to compress. Default {@link DEFAULT_MIN_COMPRESS_SIZE}. */
	minSize?: number;
	/** Native compression threads; `0` uses all logical CPUs. Default `0`. */
	concurrency?: number;
}

export interface CompressDirectoryResult {
	/** Sidecar files written, as absolute paths. */
	written: string[];
}

async function collectFiles(
	root: string,
	extensions: Set<string>,
	minSize: number
): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(root, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		if (SIDECAR_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) continue;
		if (!extensions.has(path.extname(filePath).slice(1).toLowerCase())) continue;
		const stats = await stat(filePath);
		if (stats.size < minSize) continue;
		out.push(filePath);
	}
	return out;
}

const VIRTUAL_ENTRY = 'virtual:adapter-hono-precompress';
// no extension on purpose: it can never match the compression include filter
const ENTRY_FILE_NAME = 'adapter-hono-precompress-entry';

/**
 * Walks `directory` and writes `.gz` / `.br` / `.zst` sidecars for every file
 * that matches the extension allowlist and the minimum size, using the native
 * `@medicomind/rolldown-compression` rolldown plugin at the levels resolved in
 * `options` (gzip 9 / brotli 11 / zstd 19 unless tuned). The eligible files are
 * fed to the plugin as emitted assets of a virtual-entry rolldown build that
 * writes back into `directory`.
 */
export async function compressDirectory(
	directory: string,
	options: ResolvedPrecompressOptions,
	extras: CompressDirectoryExtras = {}
): Promise<CompressDirectoryResult> {
	const minSize = extras.minSize ?? DEFAULT_MIN_COMPRESS_SIZE;

	const result: CompressDirectoryResult = { written: [] };
	if (!existsSync(directory)) return result;

	const algorithms: DefineAlgorithmResult[] = [];
	if (options.gzip) algorithms.push(defineAlgorithm('gzip', options.gzip));
	if (options.brotli) algorithms.push(defineAlgorithm('brotli', options.brotli));
	if (options.zstd) algorithms.push(defineAlgorithm('zstd', options.zstd));
	if (algorithms.length === 0 || options.extensions.size === 0) return result;

	const files = await collectFiles(directory, options.extensions, minSize);
	if (files.length === 0) return result;

	const emitAssets: Plugin = {
		name: 'adapter-hono:emit-directory-assets',
		resolveId: (id) => (id === VIRTUAL_ENTRY ? id : null),
		load: (id) => (id === VIRTUAL_ENTRY ? 'export {};' : null),
		async buildStart() {
			for (const filePath of files) {
				this.emitFile({
					type: 'asset',
					fileName: path.relative(directory, filePath).split(path.sep).join('/'),
					source: await readFile(filePath)
				});
			}
		}
	};

	// registered after the compression plugin, so its generateBundle hook runs
	// once the sidecar assets have been emitted
	const collectSidecars: Plugin = {
		name: 'adapter-hono:collect-sidecars',
		generateBundle(_options, bundle) {
			for (const fileName of Object.keys(bundle)) {
				if (SIDECAR_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
					result.written.push(path.join(directory, fileName));
				}
			}
		}
	};

	const onLog: NonNullable<InputOptions['onLog']> = (level, log, defaultHandler) => {
		if (log.code === 'EMPTY_BUNDLE') return;
		defaultHandler(level, log);
	};

	const bundle = await rolldown({
		input: VIRTUAL_ENTRY,
		plugins: [
			emitAssets,
			compression({
				include: new RegExp(`\\.(${[...options.extensions].join('|')})$`, 'i'),
				threshold: minSize,
				algorithms,
				// parity with the previous node:zlib implementation, which always
				// wrote a sidecar for every eligible file
				skipIfLargerOrEqual: false,
				concurrency: extras.concurrency ?? 0,
				logLevel: 'silent'
			}),
			collectSidecars
		],
		onLog
	});
	try {
		await bundle.write({
			dir: directory,
			entryFileNames: ENTRY_FILE_NAME,
			sourcemap: false
		});
	} finally {
		await bundle.close();
	}
	await rm(path.join(directory, ENTRY_FILE_NAME), { force: true });

	return result;
}
