# @medicomind/svelte-kit

[![CI](https://github.com/Medico-Mind/svelte-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Medico-Mind/svelte-kit/actions/workflows/ci.yml)
[![Release](https://github.com/Medico-Mind/svelte-kit/actions/workflows/release.yml/badge.svg)](https://github.com/Medico-Mind/svelte-kit/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/%40medicomind%2Fsvelte-adapter-hono?logo=npm)](https://www.npmjs.com/package/@medicomind/svelte-adapter-hono)
[![npm downloads](https://img.shields.io/npm/dm/%40medicomind%2Fsvelte-adapter-hono)](https://www.npmjs.com/package/@medicomind/svelte-adapter-hono)
[![node](https://img.shields.io/node/v/%40medicomind%2Fsvelte-adapter-hono)](https://www.npmjs.com/package/@medicomind/svelte-adapter-hono)
[![license](https://img.shields.io/npm/l/%40medicomind%2Fsvelte-adapter-hono)](./LICENSE)

Monorepo for [`@medicomind/svelte-adapter-hono`](./packages/adapter-hono) — a SvelteKit adapter that emits a standalone Node server powered by [Hono](https://hono.dev), with brotli/gzip/zstd precompression.

## Layout

- [`packages/adapter-hono`](./packages/adapter-hono) — the adapter package (see its README for full docs)
- [`examples/app`](./examples/app) — minimal SvelteKit app used by the e2e test suite

## Development

```sh
npm install
npm run build       # build the adapter package (tsup + tsc declarations)
npm test            # unit + integration + e2e, coverage-gated at 90% lines
npm run test:unit   # fast inner loop
npm run test:perf   # autocannon smoke test (requires a prior e2e run)
npm run lint        # prettier + eslint
npm run check       # tsc --noEmit
```

Releases are managed with [changesets](https://github.com/changesets/changesets): `npm run changeset` to record a change; the release workflow versions and publishes from `main` via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no `NPM_TOKEN` secret). Configure the package's Trusted Publisher on npmjs.com as `Medico-Mind/svelte-kit`, workflow `release.yml`.

CI runs lint, typecheck and the full test suite on Node 20, 22 and 24 (`.github/workflows/ci.yml`). Note that `.zst` sidecar generation needs Node ≥ 22.15 — on Node 20 the build skips zstd with a warning, and the tests assert that behavior.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow, testing structure and how to submit changes. Bug reports and feature requests go through the [issue templates](https://github.com/Medico-Mind/svelte-kit/issues/new/choose).
