# @medicomind/svelte-adapter-hono

## 1.2.0

### Minor Changes

- 0d97b7a: Generate the static asset manifest during adapt, after precompression, eliminating production startup directory scans and filesystem metadata lookups when serving assets. Use content-based SHA-256 ETags for identity, gzip, Brotli and Zstd representations.

  Improve conditional requests, HEAD headers, If-Range handling and Accept-Encoding negotiation, including explicit identity preferences and 406 responses when no available representation is acceptable. Preserve streaming runtime compression and use weak validators for dynamically compressed responses.

  Existing adapter options, defaults, runtimeConfig precedence, Hono embedding exports and SvelteKit 2 compatibility remain unchanged. Deploy the complete output including the new asset-manifest.js module, and rebuild after changing assets or sidecars. Last-Modified is no longer emitted; cache validation uses ETag.

## 1.1.0

### Minor Changes

- aa79b13: `precompress` now accepts per-encoding option objects: `gzip: { level }`, `brotli: { quality, windowBits, sectionSize }` and `zstd: { level }`, alongside the existing `true`/`false` toggles. Levels default to the previous values (gzip 9 / brotli 11 / zstd 19) and out-of-range values throw at config time.

## 1.0.1

### Patch Changes

- 743785e: Up rolldown compression version

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
