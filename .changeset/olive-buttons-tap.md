---
'@medicomind/svelte-adapter-hono': minor
---

`precompress` now accepts per-encoding option objects: `gzip: { level }`, `brotli: { quality, windowBits, sectionSize }` and `zstd: { level }`, alongside the existing `true`/`false` toggles. Levels default to the previous values (gzip 9 / brotli 11 / zstd 19) and out-of-range values throw at config time.
