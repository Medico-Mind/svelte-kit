# @medicomind/svelte-adapter-hono

## 1.0.0

### Major Changes

- c1290da: Stabilize API

### Minor Changes

- 97d8198: Add optional on-demand compression of dynamic responses via `node:zlib`. Enable it with `runtimeConfig: { compressOnDemand: true }` (or the `COMPRESS_ON_DEMAND` environment variable at runtime) to stream SSR pages, endpoints and sidecar-less static files through gzip/brotli/zstd, negotiated via `Accept-Encoding` with the same `zstd > br > gzip` tie-breaking as precompressed sidecars. Off by default; responses that already carry a `content-encoding`, declare `cache-control: no-transform`, are smaller than 1 KiB or have a non-compressible `content-type` are passed through untouched.

## 0.4.0

### Minor Changes

- a0c6372: Use @medicomind/rolldown-compression for faster compression

## 0.3.0

### Minor Changes

- f4bb56f: 1. Swap rollup to rolldown. 2. Up minimum node version to 22.

## 0.2.0

### Minor Changes

- 1195708: Add a typed `runtimeConfig` adapter option that fixes runtime configuration at build time, e.g. `adapter({ runtimeConfig: { bodySizeLimit: '1M' } })`. Every field (`port`, `host`, `origin`, `bodySizeLimit`, …) maps to a runtime environment variable and is documented and validated when the config is loaded; the server still reads unset fields from the environment, while values set in `runtimeConfig` are baked into the build and take precedence over the corresponding environment variables.
- 6ffead1: Initial release: SvelteKit adapter emitting a standalone Hono-powered Node server with brotli/gzip/zstd precompression, `Accept-Encoding` negotiation, adapter-node-compatible runtime env vars, graceful shutdown and an embeddable Hono app / fetch handler.
