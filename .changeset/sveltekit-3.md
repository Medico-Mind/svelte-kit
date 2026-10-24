---
'@medicomind/svelte-adapter-hono': major
---

Support SvelteKit 3. The adapter now requires `@sveltejs/kit@^3`, `hono@^4.13` and `@hono/node-server@^2.1` (peer dependencies) and Node ≥ 22.17.

- The server is created via `builder.generateServerInstance()` (the removed `builder.generateManifest()` is no longer used); the base path is read from `builder.config.paths.base` and the app path from `builder.getAppPath()`.
- `shims.js` is no longer emitted: SvelteKit 3 dropped `@sveltejs/kit/node/polyfills`, and every global it installed is native in supported Node versions.
- Configure the adapter in `vite.config.js` via `sveltekit({ adapter: adapter(...) })` — SvelteKit 3 no longer reads `svelte.config.js`.
