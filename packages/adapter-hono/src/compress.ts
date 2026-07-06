import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

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

/** Extensions treated as text for brotli's `BROTLI_MODE_TEXT` heuristic. */
const TEXT_EXTENSIONS = new Set([
	'html',
	'js',
	'json',
	'css',
	'svg',
	'xml',
	'txt',
	'map',
	'webmanifest'
]);

const SIDECAR_SUFFIXES = ['.gz', '.br', '.zst'];

/**
 * `precompress` adapter option: `true` enables gzip + brotli + zstd with the
 * default extension allowlist; an object toggles encodings individually.
 */
export interface PrecompressOptions {
	/** Generate `.br` sidecars. Default `true`. */
	brotli?: boolean;
	/** Generate `.gz` sidecars. Default `true`. */
	gzip?: boolean;
	/** Generate `.zst` sidecars (requires zstd support in `node:zlib`). Default `true`. */
	zstd?: boolean;
	/** File extension allowlist (without dots). Defaults to {@link DEFAULT_COMPRESS_EXTENSIONS}. */
	files?: string[];
}

/** Normalized shape of {@link PrecompressOptions}. */
export interface ResolvedPrecompressOptions {
	brotli: boolean;
	gzip: boolean;
	zstd: boolean;
	extensions: Set<string>;
}

/**
 * Normalizes the `precompress` option. Returns `null` when precompression is
 * disabled entirely.
 */
export function resolvePrecompressOptions(
	precompress: boolean | PrecompressOptions | undefined
): ResolvedPrecompressOptions | null {
	if (!precompress) return null;
	const object = precompress === true ? {} : precompress;
	return {
		brotli: object.brotli ?? true,
		gzip: object.gzip ?? true,
		zstd: object.zstd ?? true,
		extensions: new Set(
			(object.files ?? DEFAULT_COMPRESS_EXTENSIONS).map((ext) => ext.toLowerCase())
		)
	};
}

type Compressor = () => NodeJS.ReadWriteStream;

/** Factory producing a zstd compressor stream, or `null` when unsupported. */
export type ZstdFactory = (() => NodeJS.ReadWriteStream) | null;

/**
 * Detects zstd support in the running Node (`zlib.createZstdCompress`,
 * Node ≥ 22.15) and returns a level-19 compressor factory, or `null`.
 */
export function detectZstd(): ZstdFactory {
	const candidate = (
		zlib as unknown as { createZstdCompress?: (options?: object) => NodeJS.ReadWriteStream }
	).createZstdCompress;
	if (typeof candidate !== 'function') return null;
	const levelKey = (zlib.constants as unknown as Record<string, number>).ZSTD_c_compressionLevel;
	const params = levelKey === undefined ? {} : { [levelKey]: 19 };
	return () => candidate({ params });
}

export interface CompressDirectoryExtras {
	/** Minimum file size in bytes to compress. Default {@link DEFAULT_MIN_COMPRESS_SIZE}. */
	minSize?: number;
	/** Concurrent compression jobs. Default `os.cpus().length`. */
	concurrency?: number;
	/** Warning sink (zstd unavailable, etc.). Default `console.warn`. */
	warn?: (message: string) => void;
	/**
	 * zstd stream factory override, mainly for tests: pass `null` to simulate
	 * an unsupported Node, or a custom factory. Defaults to {@link detectZstd}.
	 */
	createZstd?: ZstdFactory;
}

export interface CompressDirectoryResult {
	/** Sidecar files written, as absolute paths. */
	written: string[];
	/** `true` when zstd was requested but unsupported by this Node. */
	zstdSkipped: boolean;
}

async function collectFiles(root: string): Promise<{ filePath: string; size: number }[]> {
	const out: { filePath: string; size: number }[] = [];
	const entries = await readdir(root, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const stats = await stat(filePath);
		out.push({ filePath, size: stats.size });
	}
	return out;
}

/**
 * Walks `directory` and writes `.gz` / `.br` / `.zst` sidecars for every file
 * that matches the extension allowlist and the minimum size, using a bounded
 * worker pool. Missing zstd support is reported via `warn` and skipped rather
 * than failing the build.
 */
export async function compressDirectory(
	directory: string,
	options: ResolvedPrecompressOptions,
	extras: CompressDirectoryExtras = {}
): Promise<CompressDirectoryResult> {
	const minSize = extras.minSize ?? DEFAULT_MIN_COMPRESS_SIZE;
	const concurrency = Math.max(1, extras.concurrency ?? cpus().length);
	const warn = extras.warn ?? ((message) => console.warn(message));

	const result: CompressDirectoryResult = { written: [], zstdSkipped: false };
	if (!existsSync(directory)) return result;

	const encoders: {
		ext: string;
		create: (file: { size: number; text: boolean }) => NodeJS.ReadWriteStream;
	}[] = [];

	if (options.gzip) {
		encoders.push({
			ext: '.gz',
			create: () => zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION })
		});
	}

	if (options.brotli) {
		encoders.push({
			ext: '.br',
			create: ({ size, text }) =>
				zlib.createBrotliCompress({
					params: {
						[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
						[zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
						[zlib.constants.BROTLI_PARAM_MODE]: text
							? zlib.constants.BROTLI_MODE_TEXT
							: zlib.constants.BROTLI_MODE_GENERIC
					}
				})
		});
	}

	if (options.zstd) {
		const createZstd = extras.createZstd === undefined ? detectZstd() : extras.createZstd;
		if (createZstd) {
			encoders.push({ ext: '.zst', create: () => createZstd() });
		} else {
			result.zstdSkipped = true;
			warn(
				'zstd is not supported by this Node version (requires >= 22.15 with node:zlib zstd support) — skipping .zst generation'
			);
		}
	}

	if (encoders.length === 0) return result;

	const files = (await collectFiles(directory)).filter(({ filePath, size }) => {
		if (size < minSize) return false;
		if (SIDECAR_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) return false;
		const ext = path.extname(filePath).slice(1).toLowerCase();
		return options.extensions.has(ext);
	});

	const jobs: { filePath: string; size: number; ext: string; create: Compressor }[] = [];
	for (const { filePath, size } of files) {
		const text = TEXT_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase());
		for (const encoder of encoders) {
			jobs.push({
				filePath,
				size,
				ext: encoder.ext,
				create: () => encoder.create({ size, text })
			});
		}
	}

	let index = 0;
	async function worker(): Promise<void> {
		while (index < jobs.length) {
			const job = jobs[index++]!;
			const destination = job.filePath + job.ext;
			await pipeline(createReadStream(job.filePath), job.create(), createWriteStream(destination));
			result.written.push(destination);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

	return result;
}
