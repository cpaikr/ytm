# Architecture

## Purpose and boundary

`ytm` is a Node.js product for deterministic KIS-NET YTM Matrix lookup. Its
target architecture has one external-protocol conformer: a Rust core reached
through a narrow asynchronous Node-API binding. JavaScript provides the public
toolset and CLI ergonomics; it does not implement HTTP, XML, source fallback,
or source-domain rules.

Browser, edge, Deno, Bun-runtime, and replacement Python APIs are outside the
product boundary. Bun remains a development package manager.

## System shape

```text
contracts/kisnet/openapi.yaml
              |
              v
       crates/ytm-core
    protocol + domain policy
              |
              v
       crates/ytm-node
       Node-API boundary
              |
              v
   candidate/node/src (staging)
      toolset and CLI adapters
              |
              v
 packages/node/src (at cutover)
```

Dependencies point downward only. Public adapters call the binding; the
binding maps project-owned values; the core owns all source interaction and
domain normalization. Nothing below the public adapters imports JavaScript.

## Components and start-here paths

- [`contracts/kisnet/openapi.yaml`](contracts/kisnet/openapi.yaml) — start here
  for external HTTP and serialized Nexacro facts. Its named extension is the
  canonical profile for constraints OpenAPI cannot express directly.
- `crates/ytm-core` — prepared requests, bounded transport,
  strict XML parsing, kind resolution, matrix normalization, date fallback,
  and tagged errors. It remains independent of Node-API types.
- `crates/ytm-node` — the small Node-API projection. It exposes
  async `matrix` and `kinds` calls, cancellation, capabilities, and stable
  error data; it contains no source rules.
- [`candidate/node/src`](candidate/node/src) — implemented staging home of the
  thin JavaScript adapters. Help, CLI parsing, stdout rendering, and
  synchronous public-shape validation belong here. The final cutover moves
  this package to [`packages/node/src`](packages/node/src), which remains the
  legacy comparison product until then.
- [`judge`](judge) — public-surface compatibility scenarios. The judge invokes
  built package surfaces in separate processes and never imports conformer
  internals.
- [`native-targets.json`](native-targets.json) — canonical selected release
  matrix. Candidate platform manifests, the native loader, optional
  dependencies, and CI jobs are generated or checked against this manifest.
- [`docs/provider-qualification.md`](docs/provider-qualification.md) — evidence
  and enablement decisions that protocol tests cannot establish.

The Rust and judge paths are introduced by the rewrite. Until the final
cutover, the archived JavaScript and Python conformers remain runnable for
comparison. Their presence is migration state, not the target dependency
model.

## Runtime flow

1. The CLI parses flags or a caller invokes the neutral toolset.
2. The Node adapter performs network-free public-shape validation and forwards
   normalized input plus cancellation to the binding.
3. Rust validates again at the trust boundary, resolves the canonical kind,
   prepares the contract-defined request, and performs one bounded source call
   at a time.
4. Rust enforces transport and XML constraints before interpreting protocol
   status or datasets, then returns normalized domain data and source metadata.
5. Only confirmed unavailable data can advance previous-date fallback.
6. The binding projects Rust values and tagged failures without raw bodies,
   dependency-specific errors, or panics. The adapter renders the stable
   toolset result or CLI envelope.

## Ownership and invariants

- OpenAPI and its named Nexacro profile are the only wire authority. Fixtures
  and judge expectations are independent evidence, never generated truth.
- Rust is the only component allowed to know source origins, paths, headers,
  serialized XML, transport policy, parser rules, or source dataset mappings.
- The Node-API surface is asynchronous and project-owned. Rust crate types,
  parser types, transport errors, raw response bodies, and panics do not cross
  it.
- The public toolset preserves cancellation but intentionally removes the
  legacy `context.fetch` seam. Test transport substitution happens below the
  public product boundary or in an outer black-box process preload.
- Candidate judge builds enable a compile-time-only Rust fixture transport and
  consume the judge's process-level fixture sequence. Release builds cannot
  enable or select it. Rust conformance tests compare the same core request and
  outcome projections to OpenAPI; native clean-install tests exercise the
  unmodified release build separately.
- Rust returns source metadata and capability projections. JavaScript does not
  recreate source facts or copy the canonical kind catalog.
- Canonical kinds are merged with discovery by code. Discovery may add values;
  it cannot remove or redefine a canonical value. Conflicts fail explicitly.
- Transport is sequential, bounded, redirect-free, and has no automatic retry.
  Product date fallback is not a transport retry and advances only after a
  confirmed empty result.
- Matrix lookup performs initialization followed by retrieval for each date.
  The maximum fallback window therefore permits 32 dates and 64 sequential
  HTTP calls, each with its own 20-second deadline; caller cancellation remains
  the overall stop mechanism.
- Error categories and recovery metadata are stable project values. Adapters
  preserve them instead of translating dependency messages.
- Generated declarations, native loaders, platform manifests, package
  dependencies, and built distribution files must have a deterministic
  freshness check before cutover.

## Runtime and native distribution

The cutover raises the minimum supported runtime to Node.js 22 rather than
claiming support for an end-of-life major. Consumer validation covers Node 22
and 24 plus Node 26 for forward compatibility.

The selected native matrix is Linux GNU x64/ARM64, macOS Intel/ARM64, and
Windows x64. Selection is not a support claim: each platform becomes supported
only after its own native runner builds the artifact and a clean consumer
installs the packed root package, resolves the executable and toolset export,
and completes a fixture smoke. musl, Windows ARM64/ia32, FreeBSD, Android, and
WASM remain outside the initial cutover claim.

## Release and removal boundary

Release Please remains the version, changelog, and tag authority. At cutover it
will manage only the Node root package; native platform packages use the exact
same version and are collected before the root npm artifact is publishable.
The Node release workflow keeps the established Node tag namespace.

The cutover removes both legacy conformers, the Python package and workflows,
the JavaScript XML dependency, linked Node/Python release assumptions, and
claims that those paths remain active. Historical commits, component tags, and
published artifacts stay immutable. Publication, PyPI deprecation, and the
final main-branch merge require authority outside this rewrite.
