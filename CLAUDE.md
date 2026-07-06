# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

npm-workspaces monorepo for `@medicomind/svelte-adapter-hono` (`packages/adapter-hono`) — a SvelteKit adapter that emits a standalone Node server powered by Hono, with gzip/brotli/zstd precompression served via `Accept-Encoding` negotiation. `examples/app` is a minimal SvelteKit app consumed by the e2e tests. Repo home: https://github.com/Medico-Mind/svelte-kit. Package names must stay lowercase (`@medicomind/...`) — npm rejects uppercase scopes.

## Commands

Run from the repo root (they proxy into the workspace):

```sh
npm run build       # tsup (JS) + tsc -p tsconfig.build.json (.d.ts) for the adapter
npm test            # build + unit + integration + e2e with coverage (gated: 90% lines)
npm run test:unit   # fast inner loop, no build needed (tests import src/ directly)
npm run test:perf   # autocannon smoke; requires examples/app/build to exist (run e2e first)
npm run lint        # prettier --check + eslint
npm run format      # prettier --write
npm run check       # tsc --noEmit
```

Single test file / test name (from `packages/adapter-hono`):

```sh
npx vitest run tests/unit/negotiate.test.ts
npx vitest run tests/unit/app.test.ts -t 'redirects'
```

**Integration and e2e tests use `dist/`, not `src/`** — rebuild (`npm run build`) after changing `src/` before running them; `npm test` does this automatically. The e2e suite also runs `npm run build` inside `examples/app` (vite build) in its `beforeAll`.

Releases: changesets (`npm run changeset` to record a change). `release.yml` publishes from `main` via npm Trusted Publishing (OIDC, no `NPM_TOKEN`; needs npm ≥ 11.5.1). CI matrix: Node 20/22/24.

## Architecture

Three layers in `packages/adapter-hono/src`, deliberately separated for testability:

- `src/index.ts` + `src/compress.ts` — **build-time**. The adapter factory (`adapt()`) and the precompression walker (bounded worker pool; gzip 9 / brotli 11 / zstd 19).
- `src/runtime/*` — **pure runtime logic**, unit-tested in-process: `app.ts` (`buildHonoApp()`: static → prerendered → SSR middleware chain), `assets.ts` (boot-time file manifest — no fs calls on the hot path — plus streaming file serving, ETag/304, ranges), `negotiate.ts` (q-value parsing, `zstd > br > gzip` tie-break), `request.ts` (ORIGIN/proxy-header URL rewrite, streaming body-size limit), `address.ts`, `env-core.ts`, `lifecycle.ts` (graceful shutdown, `sveltekit:shutdown` event, idle timeout).
- `src/files/*` — **templates** copied into the user's build output. They import via placeholder specifiers (`'SERVER'`, `'MANIFEST'`, `'ENV'`, `'HANDLER'`, `'SHIMS'`, bare `ENV_PREFIX`) that `adapt()` rewrites to relative paths; `src/files/ambient.d.ts` declares them for tsc. tsup inlines `src/runtime/*` into each template (`dist/files/*.js`), keeping placeholders and `hono`/`@hono/node-server`/`@sveltejs/kit` external.

### The two-pass rollup in `adapt()` — do not merge the passes

1. **Pass 1**: SvelteKit server (`writeServer` output + generated manifest) → `build/server/` with chunks.
2. **Pass 2**: each template is bundled as its **own single-entry rollup build** to the build root, resolving `hono`/`@hono/node-server` from the _user's_ node_modules (they are peer deps). Imports between emitted top-level modules (`./handler.js`, `./env.js`, `./shims.js`, `./server/*.js`) stay external with `makeAbsoluteExternalsRelative: false`.

Rationale: `handler.js` locates `client/` and `prerendered/` via `import.meta.url`. A multi-entry pass lets rollup hoist the handler module into `chunks/`, silently breaking that lookup (this bug actually occurred). Single-entry builds cannot be code-split.

### Testing structure

- `tests/unit/` — imports `src/` directly; fixtures in os tmpdir.
- `tests/integration/adapter.test.ts` — runs real `adapt()` against a **fake Builder** with a stub `Server` class, then boots the emitted output with `node` and asserts over HTTP. Its temp dirs live in `packages/adapter-hono/.test-tmp/` (gitignored) — required so the adapt-time rollup can resolve `hono` from workspace node_modules; os tmpdir would break resolution.
- `tests/e2e/example.test.ts` — vite-builds `examples/app`, boots `build/index.js`, asserts SSR/static/prerendered/negotiation/graceful shutdown, and imports `build/app.js` in-process for the embedding test.
- Coverage excludes `src/files/**`: the templates are thin wiring exercised in child processes where v8 coverage can't see them; their behavior is covered by integration/e2e.
- `tests/helpers/http.ts#rawRequest` uses `agent: false` on purpose — keep-alive reuse after early-413 responses poisons pooled sockets (was a flaky ECONNRESET).

### Version-sensitive facts

- zstd compression needs Node ≥ 22.15 (`zlib.createZstdCompress`); on older Node the build warns and skips `.zst` — tests branch on `detectZstd()` (also the injection point for simulating unsupported Node). Serving `.zst` has no Node requirement.
- `.d.ts` generation is plain `tsc -p tsconfig.build.json`, not tsup's dts — tsup's dts build breaks on TypeScript 5.9+/6.
- `@rollup/plugin-commonjs`/`json` need the `interopDefault` shim in `src/index.ts` under NodeNext resolution.
