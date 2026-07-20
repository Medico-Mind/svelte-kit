---
'@medicomind/svelte-adapter-hono': minor
---

Add optional on-demand compression of dynamic responses via `node:zlib`. Enable it with `runtimeConfig: { compressOnDemand: true }` (or the `COMPRESS_ON_DEMAND` environment variable at runtime) to stream SSR pages, endpoints and sidecar-less static files through gzip/brotli/zstd, negotiated via `Accept-Encoding` with the same `zstd > br > gzip` tie-breaking as precompressed sidecars. Off by default; responses that already carry a `content-encoding`, declare `cache-control: no-transform`, are smaller than 1 KiB or have a non-compressible `content-type` are passed through untouched.
