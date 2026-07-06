# @medicomind/svelte-adapter-hono

[SvelteKit](https://svelte.dev/docs/kit) adapter that builds a **standalone Node server powered by [Hono](https://hono.dev)** (`hono` + `@hono/node-server`) — a drop-in alternative to [`@sveltejs/adapter-node`](https://svelte.dev/docs/kit/adapter-node) with built-in **brotli, gzip and zstd precompression** served via `Accept-Encoding` negotiation.

- Self-contained `build/` output: `node build` and you're serving.
- Static assets → prerendered pages → SSR, in that order, with zero sync fs calls and no per-request buffering on the hot path (file existence is resolved from a manifest built once at boot).
- `.gz` / `.br` / `.zst` sidecars generated at build time and negotiated per request with full q-value parsing.
- Composable: embed the generated Hono app inside your own server.

## Installation

```sh
npm install --save-dev @medicomind/svelte-adapter-hono hono @hono/node-server
```

`@sveltejs/kit`, `hono` and `@hono/node-server` are peer dependencies — the emitted build bundles the Hono version installed in **your** project.

## Usage

```js
// svelte.config.js
import adapter from '@medicomind/svelte-adapter-hono';

/** @type {import('@sveltejs/kit').Config} */
export default {
	kit: {
		adapter: adapter({
			out: 'build',
			precompress: true,
			envPrefix: ''
		})
	}
};
```

Build and run:

```sh
npm run build
node build
```

## Options

| Option        | Type                            | Default   | Description                                                                                       |
| ------------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| `out`         | `string`                        | `'build'` | Output directory for the standalone build.                                                        |
| `precompress` | `boolean \| PrecompressOptions` | `true`    | Generate `.gz`/`.br`/`.zst` sidecars for static assets and prerendered pages (see below).         |
| `envPrefix`   | `string`                        | `''`      | Prefix for all runtime environment variables (e.g. `'MY_APP_'` → `MY_APP_PORT`, `MY_APP_HOST` …). |

### `precompress`

`true` enables all three encodings. An object gives fine-grained control:

```js
adapter({
	precompress: {
		gzip: true, // .gz  via zlib gzip, level 9              (default true)
		brotli: true, // .br  via brotli, quality 11, size hint  (default true)
		zstd: true, // .zst via zstd, level 19                 (default true)
		files: ['html', 'js', 'json', 'css', 'svg', 'xml', 'wasm', 'txt', 'map', 'ico', 'webmanifest']
	}
});
```

- Only files **≥ 1024 bytes** whose extension is in the `files` allowlist are compressed.
- Compression runs in a bounded worker pool (`os.cpus().length` jobs).
- **zstd generation requires Node ≥ 22.15 / ≥ 23.8** (zstd support in `node:zlib`). On older Node versions the build **warns and skips** `.zst` — it never fails. Serving `.zst` sidecars has **no** Node version requirement (the precompressed file is streamed as-is).

### Serving negotiation

For static assets and prerendered pages the server parses `Accept-Encoding` with q-values and picks the best available sidecar. When q-values tie, preference is **`zstd` > `br` > `gzip` > identity**. Responses carry the correct `content-encoding`, the original `content-type` and `vary: accept-encoding`. Range requests are never served from compressed sidecars. When no sidecar matches, the identity file is streamed.

## Runtime environment variables

All names respect `envPrefix`.

| Variable           | Default   | Description                                                                                                      |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`             | `3000`    | Port to listen on (`0` → random ephemeral port).                                                                 |
| `HOST`             | `0.0.0.0` | Interface to bind.                                                                                               |
| `SOCKET_PATH`      | —         | Unix domain socket path; overrides `PORT`/`HOST` when set.                                                       |
| `ORIGIN`           | —         | Public origin of the app (`https://example.com`). Wins over the header options below.                            |
| `PROTOCOL_HEADER`  | —         | Header carrying the original protocol behind a proxy (e.g. `x-forwarded-proto`).                                 |
| `HOST_HEADER`      | —         | Header carrying the original host (e.g. `x-forwarded-host`).                                                     |
| `PORT_HEADER`      | —         | Header carrying the original port (e.g. `x-forwarded-port`).                                                     |
| `ADDRESS_HEADER`   | —         | Header to read the client IP from (e.g. `x-forwarded-for`).                                                      |
| `XFF_DEPTH`        | `1`       | With `ADDRESS_HEADER=x-forwarded-for`: how many proxies deep to look, counting from the right.                   |
| `BODY_SIZE_LIMIT`  | `512K`    | Max request body size in bytes; supports `K`/`M`/`G` suffixes and `Infinity` (`0` also disables). 413 on exceed. |
| `SHUTDOWN_TIMEOUT` | `30`      | Seconds to wait for in-flight requests after `SIGINT`/`SIGTERM` before force-closing sockets.                    |
| `IDLE_TIMEOUT`     | `0`       | If > 0: gracefully shut down after this many seconds without in-flight requests. `0` disables.                   |

### Graceful shutdown

On `SIGINT`/`SIGTERM` the server stops accepting connections, lets in-flight requests finish (up to `SHUTDOWN_TIMEOUT` seconds), then force-closes lingering sockets. Once fully closed, a `sveltekit:shutdown` event is emitted on `process` with the reason (`SIGINT`, `SIGTERM` or `IDLE`):

```js
process.on('sveltekit:shutdown', async (reason) => {
	await db.close();
	console.log(`shut down: ${reason}`);
});
```

## Custom server / embedding

The build emits composable modules alongside `index.js`:

```js
// A Hono instance — mount it in your own Hono server
import { Hono } from 'hono';
import { app } from './build/app.js';

const server = new Hono();
server.get('/healthz', (c) => c.text('ok'));
server.route('/', app); // static → prerendered → SSR
```

```js
// A fetch-style handler: (request: Request) => Promise<Response>
import { handler } from './build/handler.js';

const response = await handler(new Request('http://localhost/'));
```

`env.js` (prefixed env reader) and `shims.js` (SvelteKit's Node polyfills, side-effect import) are also emitted. When embedding, the client IP falls back to the `@hono/node-server` socket when available; behind another runtime configure `ADDRESS_HEADER`.

## Comparison with `@sveltejs/adapter-node`

| Feature                                        | adapter-node            | @medicomind/svelte-adapter-hono              |
| ---------------------------------------------- | ----------------------- | -------------------------------------------- |
| HTTP layer                                     | polka + sirv            | hono + @hono/node-server                     |
| Precompression                                 | gzip, brotli            | gzip, brotli, **zstd**                       |
| Precompressed serving with q-value negotiation | ✅                      | ✅ (+ `zstd > br > gzip` tie-breaking)       |
| `ORIGIN` / proxy header handling               | ✅                      | ✅ (same env vars)                           |
| `BODY_SIZE_LIMIT`                              | ✅                      | ✅ (same syntax, streaming enforcement)      |
| Graceful shutdown + `sveltekit:shutdown`       | ✅                      | ✅ (+ standalone `IDLE_TIMEOUT`)             |
| Embeddable handler                             | Node req/res middleware | **fetch-style handler + mountable Hono app** |
| systemd socket activation                      | ✅                      | ❌ out of scope (see below)                  |
| HTTP/2, TLS termination, clustering            | ❌                      | ❌ out of scope                              |

### Out of scope

systemd socket activation (`LISTEN_FDS`), HTTP/2, TLS termination, clustering, and on-the-fly compression of dynamic SSR responses are intentionally not implemented (put a reverse proxy or CDN in front, or open an issue if you need them). `IDLE_TIMEOUT` here is a standalone idle shutdown rather than a socket-activation companion.

## Troubleshooting

**Form actions fail with cross-site POST errors** — SvelteKit can't infer the public origin behind a proxy. Set `ORIGIN=https://your.site`, or `PROTOCOL_HEADER=x-forwarded-proto` + `HOST_HEADER=x-forwarded-host` (+ `PORT_HEADER` if a non-default port) if your proxy sets them.

**`event.getClientAddress()` returns the proxy IP** — set `ADDRESS_HEADER=x-forwarded-for` and make sure `XFF_DEPTH` matches the number of trusted proxies in front of the server (it counts from the right of the header).

**Only ADDRESS_HEADER you trust** — any client can send `x-forwarded-for`; only configure headers your proxy overwrites.

**No `.zst` files in the build** — your build machine's Node lacks zstd in `node:zlib` (needs ≥ 22.15 / ≥ 23.8). The build logs a warning and emits `.gz`/`.br` only; serving still works everywhere.

**413 Payload Too Large on legitimate uploads** — raise `BODY_SIZE_LIMIT` (e.g. `BODY_SIZE_LIMIT=10M`), or set it to `Infinity` and enforce limits in your own handlers.

**Unknown prefixed env vars warning** — with `envPrefix` set, unrecognized `PREFIX_*` variables log a warning to catch typos; unprefixed variables are ignored entirely.

## Output layout

```
build/
├── index.js        # server entry: node build
├── handler.js      # exports { app, handler }
├── app.js          # re-exports { app, handler } for embedding
├── env.js          # prefixed env reader
├── shims.js        # SvelteKit Node polyfills
├── client/         # static assets (+ .gz/.br/.zst sidecars)
├── prerendered/    # prerendered pages (+ sidecars)
└── server/         # bundled SvelteKit server + manifest
```

## License

MIT
