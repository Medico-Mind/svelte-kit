# Contributing

Thanks for your interest in contributing to `@medicomind/svelte-adapter-hono`! Bug reports, feature requests and pull requests are all welcome.

## Repository layout

This is an npm-workspaces monorepo:

- [`packages/adapter-hono`](./packages/adapter-hono) — the adapter package itself
- [`examples/app`](./examples/app) — a minimal SvelteKit app consumed by the e2e test suite

## Prerequisites

- Node.js ≥ 22.15
- npm ≥ 10

## Getting started

```sh
git clone https://github.com/Medico-Mind/svelte-kit.git
cd svelte-kit
npm install
npm run build
npm test
```

## Development workflow

All commands run from the repo root (they proxy into the workspace):

```sh
npm run build       # tsup (JS) + tsc (declarations) for the adapter
npm test            # build + unit + integration + e2e with coverage (gated: 90% lines)
npm run test:unit   # fast inner loop — no build needed, tests import src/ directly
npm run test:perf   # autocannon smoke; requires examples/app/build (run e2e first)
npm run lint        # prettier --check + eslint
npm run format      # prettier --write
npm run check       # tsc --noEmit
```

To run a single test file or test name (from `packages/adapter-hono`):

```sh
npx vitest run tests/unit/negotiate.test.ts
npx vitest run tests/unit/app.test.ts -t 'redirects'
```

### Things to know before you dig in

- **Integration and e2e tests run against `dist/`, not `src/`.** Rebuild (`npm run build`) after changing `src/` before running them — `npm test` does this automatically, `test:unit` doesn't need it.
- The source is split into three layers on purpose (see `packages/adapter-hono/src`):
  - `index.ts` + `compress.ts` — build-time adapter logic and precompression
  - `runtime/*` — pure runtime logic, unit-tested in-process
  - `files/*` — templates copied into the user's build output; they import via placeholder specifiers (`'SERVER'`, `'MANIFEST'`, `'ENV'`, …) that `adapt()` rewrites at build time
- Coverage excludes `src/files/**` — the templates are thin wiring exercised in child processes; their behavior is covered by the integration/e2e suites.

## Submitting changes

1. Fork the repo and create a branch from `main`.
2. Make your change, adding or updating tests to cover it.
3. If the change affects the published package, record a changeset:
   ```sh
   npm run changeset
   ```
   Pick the appropriate bump (patch/minor/major) and write a short, user-facing summary. Docs-only or CI-only changes don't need one.
4. Make sure the full suite passes locally:
   ```sh
   npm run lint && npm run check && npm test
   ```
5. Open a pull request. CI runs lint, typecheck and the full test suite on Node 22 and 24.

## Releases

Releases are automated with [changesets](https://github.com/changesets/changesets). When changesets land on `main`, the release workflow opens (or updates) a version PR; merging that PR publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance). Contributors never need to publish manually.

## Reporting bugs and requesting features

Please use the [issue templates](https://github.com/Medico-Mind/svelte-kit/issues/new/choose). For bugs, a minimal reproduction (a small SvelteKit app + `svelte.config.js`) makes fixes dramatically faster.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
