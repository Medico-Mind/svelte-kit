# Build-time asset manifest: implementation and performance report

## Decision and contract

Keep the change: build-time discovery removes production filesystem metadata lookups, produces content-based validators and reduces measured startup cost. Request throughput shows no observed regression exceeding 5% in any paired case; these short runs do not establish a statistically significant throughput improvement. Correctness is the gating criterion; performance tests assert valid responses and zero startup discovery calls, without machine-dependent timing thresholds.

Scope: adapter-hono 1.x, SvelteKit 2, standalone Node, composable Hono app and fetch handler. This is a focused transfer of filesystem discovery to `adapt()`, with HTTP corrections required by the new validators. No dependency or public option changes.

## Architecture

1. `writeClient` and `writePrerendered` preserve SvelteKit base paths.
2. Existing native `@medicomind/rolldown-compression` precompression runs unchanged.
3. Build-only `src/asset-manifest.ts` walks the output once, excludes symlinks and streams each file through SHA-256. Size is counted from the same bytes. Only one file is read at a time.
4. `asset-manifest.js` serializes compact rows: pathname, size, MIME, quoted hash and optional encoding names. Sidecars remain directly addressable and share metadata objects with their base resource. No content buffers, build-machine absolute paths or duplicated pathname fields are serialized.
5. `handler.js` imports the generated maps directly. Paths resolve relative to the module, so the build is relocatable. Import still has O(n) parsing/Map initialization cost; there is no O(n) filesystem discovery.
6. Static serving selects the representation before conditional evaluation or opening the stream. HEAD/304 do not open files. Static runtime compression shares the streaming encoder with SSR middleware, which runs only for SSR/API fallthrough.

Strong validators hash each representation's exact bytes, so changing compression settings changes that sidecar's ETag even when identity content is unchanged. Runtime-compressed static responses use encoding-specific weak validators. Dynamic validators remain weak when transformed, including subsequent 304 responses. Conditional comparison and content negotiation follow [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3).

## Compatibility and observable changes

Unchanged public API: package name/version range, options/defaults, `precompress` boolean/object forms and compression levels, `runtimeConfig` precedence, `envPrefix`, every runtime environment setting, `app`/`handler` exports, `node build`, Hono and `@hono/node-server`, immutable caching, prerendered routing and single-range behavior. No new configuration is required.

Potential deployment/HTTP compatibility changes:

- Include the new `asset-manifest.js` file in deployment. Treat output assets and sidecars as build artifacts: additions/changes after adapt require rebuilding. Restart alone no longer discovers new files.
- Content ETags replace size/mtime weak validators; old cached validators initially receive a full response. `Last-Modified` is removed. `If-Modified-Since` was not used for validation before this change.
- Explicitly unacceptable representations now return 406 instead of violating `identity;q=0` or `*;q=0`. Explicit identity quality participates in selection. Normal encoding priority remains zstd > br > gzip.
- `If-Range` now honors strong identity ETags; stale/weak validators or dates cause full identity responses. Malformed and multiple ranges retain the existing full-response behavior.
- On-demand HEAD headers correspond to the selected GET representation, and transformed SSR validators are weak.

Internal `buildHonoApp` receives maps instead of directory roots. It is not a package export; documented generated embedding exports are unchanged.

SvelteKit 2 APIs deliberately retained: `builder.generateManifest({ relativePath })`, `writeServer`, `writeClient`, `writePrerendered`, `builder.prerendered.paths`, `Server(manifest)`, `Server.init`/`respond`, `$app/server` read callback, base/appPath handling and `supports.read`. Neither `builder.generateServerInstance()` nor `builder.manifest` is introduced. Peer range remains `@sveltejs/kit: ^2.22.0`; example verification uses installed 2.70.1. See the [Builder API](https://svelte.dev/docs/kit/@sveltejs-kit#Builder).

## Measurements (measured unless stated otherwise)

Environment: Apple M5 Pro (18 logical CPUs), macOS/Darwin 25.6.0 arm64, Node 26.5.1, SvelteKit 2.70.1, Vite 8.1.5. Baseline source: `e11639eaf4e64b9a1fe0f6057a192a74c982a2a8`, rebuilt in a separate temporary tree using the same installed dependencies. Candidate: working tree accompanying this report. Both examples were built outside Vitest for production-mode comparisons.

Three sequential baseline/candidate pairs, without overlapping startup and request benchmarks. Warm filesystem cache; no CPU pinning or background-load isolation. All raw samples are in [asset-manifest-samples.json](asset-manifest-samples.json). The first baseline request run was broadly slower than subsequent runs (including unchanged SSR/API code), indicating substantial environmental/warmup noise. It is retained rather than silently discarded. Ranges below are observed paired speedup ranges, **not confidence intervals**. Three pairs are insufficient for a robust statistical non-regression claim.

### Startup

Seven fresh Node processes per asset count per pair (21 samples per version/count). Timing covers `handler.js` import and initialization, including SvelteKit server and Hono setup; process creation, TCP listen, fixture generation and forced GC are excluded. Each fixture has 100/1,000/10,000 small immutable JS assets plus the example's prerendered page/sidecars. Public fs `statSync`/`readdirSync` calls are instrumented; these counts describe adapter discovery, not Node's internal module-loader syscalls.

| Client assets | Baseline median ms | Candidate median ms | Derived speedup | stat / readdir calls |
| ------------- | -----------------: | ------------------: | --------------: | -------------------- |
| 100           |              11.33 |               10.37 |           1.09× | 104 / 4 → 0 / 0      |
| 1,000         |              15.83 |               12.95 |           1.22× | 1004 / 4 → 0 / 0     |
| 10,000        |              53.81 |               33.14 |           1.62× | 10004 / 4 → 0 / 0    |

The limiting mechanism removed is one stat per asset plus directory enumeration, established directly by the counters and the startup scaling measurements. Module loading still scales with metadata size; no constant-time startup claim is made.

### Requests

25 keep-alive connections, 500 warmup requests per scenario, then 3 seconds of closed-loop traffic. Node's HTTP client is used for every scenario: autocannon's installed parser did not complete HEAD responses with Content-Length, making that result unusable. No decompression occurs in the load client. Setup and compression are outside timing. Static fixture: 1,024 deterministic JS exports, 29523 bytes, identical sidecar bytes in both versions; SHA-256 is recorded with the samples. Range is bytes=0-100. SSR is the example `/`, API is `/ip`; runtime compression is off for these overhead measurements.

| Scenario            | Baseline median req/s | Candidate median req/s | Paired throughput ratio range | Median p99 ms, before → after |
| ------------------- | --------------------: | ---------------------: | ----------------------------: | ----------------------------: |
| immutable JS        |                18,189 |                 18,654 |                   1.026–1.446 |                   2.78 → 2.71 |
| immutable JS (br)   |                20,720 |                 21,752 |                   1.003–1.485 |                   2.48 → 2.37 |
| immutable JS (zstd) |                21,921 |                 21,193 |                   0.967–1.414 |                   2.15 → 2.41 |
| HEAD immutable JS   |                39,519 |                 40,443 |                   0.992–1.524 |                   1.24 → 1.19 |
| 304 If-None-Match   |                40,065 |                 39,558 |                   0.987–1.525 |                   1.20 → 1.25 |
| Range               |                24,421 |                 24,743 |                   0.999–1.189 |                   1.80 → 1.88 |
| SSR route           |                16,951 |                 16,527 |                   0.975–1.456 |                   3.05 → 3.33 |
| API route           |                37,400 |                 37,382 |                   0.997–1.416 |                   1.77 → 1.75 |

All six request suites returned the expected HTTP statuses and zero request/response errors. Every observed paired throughput ratio exceeds 0.95. In the final two pairs, SSR/API ratios were 0.975–1.012. There is no observed material overhead regression; an absolute SSR speedup is not established. Latency tails and first-run variation preclude a general production latency guarantee.

### Memory and output size

Heap deltas are measured after forced GC relative to pre-import heap. They include retained server/runtime modules and asset metadata, not only the Map. Manifest bytes are exact generated module sizes (including the example prerendered metadata).

| Client assets | Baseline median retained MiB | Candidate median retained MiB | Manifest bytes |
| ------------- | ---------------------------: | ----------------------------: | -------------: |
| 100           |                         2.03 |                          2.03 |         12,280 |
| 1,000         |                         2.75 |                          2.70 |        113,080 |
| 10,000        |                         9.61 |                          8.23 |      1,130,080 |

No file contents are retained. Peak RSS, peak build memory, allocator call counts, Windows/Linux behavior, Node 22 performance and cold disk-cache startup were not measured. Build hashing adds one streaming read per output file and shifts that work out of deployment startup. The generated manifest consumes additional output space in exchange for eliminating discovery and providing stable validators.

## Correctness evidence

- Unit tests: identity/gzip/Brotli/real Zstd bodies; q-values, wildcard/identity exclusions, deterministic priority; representation lengths/MIME/Vary; GET/HEAD parity; strong and weak ETag lists/wildcards; same-content stability across location/mtime and changed content of equal size; independent sidecar hashes; Range/suffix/open-ended/416/malformed and If-Range; immutable caching; prerendered routes.
- Generated module tests: deterministic serialization, absent directories, symlink exclusion, relocation, Unicode/spaces/literal percent/query/fragment characters in filenames, percent-encoded slashes, malformed URI, traversal rejection, and exclusion of files added after generation.
- Integration: real adapt/bundling, all sidecars, disabled precompression, base paths, baked body-size and compression precedence over prefixed environment variables, static/prerendered/SSR serving.
- E2E: actual SvelteKit 2 build; standalone and embedding exports; SSR/API/prerender; runtime compression; graceful in-flight shutdown on SIGTERM and SIGINT. A relocated output outside the repository blocks public sync/callback/promise metadata APIs at startup and during requests, and counts file opens to ensure HEAD/304 open nothing.
- Existing lifecycle, proxy/address, request limits, env parsing and configurable compression tests remain.

Validation commands: `npm test` (including build, coverage and example build), `npm run check`, `npm run lint`, `npm run test:perf`. Final correctness run: 216 tests across 13 files passed, with 97.54% line coverage and 96.32% statement coverage; TypeScript and lint passed. The final production build also passed all 9 performance tests; its additional smoke samples are stored separately as `finalSmoke` and are not mixed into the three-pair tables. One earlier run encountered the existing oversized-upload ECONNRESET race in the HTTP test client; the final run result is reported without treating retries as proof that the race cannot recur.

## Reproduction

Build the baseline commit in a separate tree and the candidate with the same dependency versions. When sharing node_modules via a symlink, point the baseline example's adapter import at its own `../../packages/adapter-hono/dist/index.js` so workspace links cannot select the candidate accidentally. Run `npm run build` in each adapter package, then `npm run build` in each example (outside Vitest, with NODE_ENV unset).

From the candidate repository:

```sh
PERF_BUILD_DIR=/absolute/baseline/examples/app/build PERF_BASELINE=true PERF_OUTPUT=/tmp/before npm run test:perf
PERF_BUILD_DIR=/absolute/candidate/examples/app/build PERF_OUTPUT=/tmp/after npm run test:perf
```

Repeat sequentially three times with distinct output prefixes. Each invocation writes `-requests.json` and `-startup.json`. The startup suite always builds fixture metadata before measurement; baseline runtime ignores that module. Request fixtures are created in temporary standalone copies and cleaned up. The performance config serializes files to prevent concurrent benchmark interference. `PERF_BASELINE=true` only disables the zero-discovery assertions, never changes runtime code.

## Changed files

All paths below are relative to `packages/adapter-hono`:

- `src/asset-manifest.ts`: build-only scanning, hashes, compact module generation.
- `src/index.ts`: generation after precompression and external module wiring.
- `src/files/handler.ts`, `src/files/ambient.d.ts`, `tsup.config.ts`: direct generated-manifest import.
- `src/runtime/app.ts`: injected maps and static/SSR compression routing.
- `src/runtime/assets.ts`: metadata-only serving, validators, Range, HEAD and on-demand representation selection.
- `src/runtime/negotiate.ts`: explicit identity/wildcard exclusions and malformed quality handling.
- `src/runtime/compress-on-demand.ts`: shared streaming encoder, weak validators and HEAD/304 behavior.
- `tests/unit/asset-manifest.test.ts`: generated module, hashing, relocation and security coverage.
- `tests/unit/assets.test.ts`, `app.test.ts`, `negotiate.test.ts`, `compress-on-demand.test.ts`, `prerendered.test.ts`: HTTP cases and map-based fixtures.
- `tests/integration/adapter.test.ts`, `tests/e2e/example.test.ts`: base paths, config precedence, standalone metadata guard and signals.
- `tests/perf/startup.test.ts`, `tests/perf/smoke.test.ts`, `vitest.perf.config.ts`: reproducible startup/request measurements.
- `README.md`, this report and `asset-manifest-samples.json`: deployment semantics, measurements and raw evidence.

`src/compress.ts`, runtime env/proxy/body-limit/lifecycle implementations, standalone entry, prerender routing implementation, package manifests and lockfile are deliberately unchanged.
