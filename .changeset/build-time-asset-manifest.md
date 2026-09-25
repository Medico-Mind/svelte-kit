---
'@medicomind/svelte-adapter-hono': minor
---

Generate the static asset manifest during adapt, after precompression, eliminating production startup directory scans and filesystem metadata lookups when serving assets. Use content-based SHA-256 ETags for identity, gzip, Brotli and Zstd representations.

Improve conditional requests, HEAD headers, If-Range handling and Accept-Encoding negotiation, including explicit identity preferences and 406 responses when no available representation is acceptable. Preserve streaming runtime compression and use weak validators for dynamically compressed responses.

Existing adapter options, defaults, runtimeConfig precedence, Hono embedding exports and SvelteKit 2 compatibility remain unchanged. Deploy the complete output including the new asset-manifest.js module, and rebuild after changing assets or sidecars. Last-Modified is no longer emitted; cache validation uses ETag.
