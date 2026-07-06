# @medicomind/svelte-adapter-hono

## 0.2.0

### Minor Changes

- 1195708: Add a typed `runtimeConfig` adapter option that fixes runtime configuration at build time, e.g. `adapter({ runtimeConfig: { bodySizeLimit: '1M' } })`. Every field (`port`, `host`, `origin`, `bodySizeLimit`, …) maps to a runtime environment variable and is documented and validated when the config is loaded; the server still reads unset fields from the environment, while values set in `runtimeConfig` are baked into the build and take precedence over the corresponding environment variables.
- 6ffead1: Initial release: SvelteKit adapter emitting a standalone Hono-powered Node server with brotli/gzip/zstd precompression, `Accept-Encoding` negotiation, adapter-node-compatible runtime env vars, graceful shutdown and an embeddable Hono app / fetch handler.
