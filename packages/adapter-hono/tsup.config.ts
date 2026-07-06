import { defineConfig } from 'tsup';

/**
 * Two build passes:
 *
 * 1. The adapter itself (`dist/index.js`) — the build-time API consumed from
 *    `svelte.config.js`. Its dependencies (rollup + plugins) stay external.
 *
 * 2. The runtime templates (`dist/files/*.js`) — copied into the user's build
 *    output by `adapt()`. Each template is bundled flat (shared `src/runtime`
 *    modules are inlined) so the template files are freestanding, except for:
 *    - placeholder specifiers (`SERVER`, `MANIFEST`, `ENV`, `HANDLER`, `SHIMS`)
 *      which `adapt()` rewrites to relative paths in the emitted build, and
 *    - `hono` / `@hono/node-server` / `@sveltejs/kit`, which are resolved from
 *      the user's node_modules and bundled by the adapt-time rollup pass.
 */
export default defineConfig([
	{
		entry: { index: 'src/index.ts' },
		format: ['esm'],
		platform: 'node',
		target: 'node20',
		// .d.ts files are emitted by `tsc -p tsconfig.build.json` (see the build script)
		dts: false,
		sourcemap: true,
		clean: true
	},
	{
		entry: {
			'files/index': 'src/files/index.ts',
			'files/handler': 'src/files/handler.ts',
			'files/app': 'src/files/app.ts',
			'files/env': 'src/files/env.ts',
			'files/shims': 'src/files/shims.ts'
		},
		format: ['esm'],
		platform: 'node',
		target: 'node20',
		splitting: false,
		dts: false,
		sourcemap: false,
		external: [
			'ENV',
			'HANDLER',
			'MANIFEST',
			'SERVER',
			'SHIMS',
			'hono',
			/^hono\//,
			'@hono/node-server',
			/^@hono\/node-server\//,
			'@sveltejs/kit',
			/^@sveltejs\/kit\//
		]
	}
]);
