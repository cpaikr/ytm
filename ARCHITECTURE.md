# Architecture

## Purpose and boundary

`ytm` is a Node.js product for deterministic KIS-NET YTM Matrix lookup. One
Rust core conforms to the external HTTP and Nexacro protocol through a narrow
asynchronous Node-API binding. JavaScript provides public toolset and CLI
ergonomics only.

Browser, edge, Deno, Bun-runtime, proxy discovery, and Python APIs are outside
the product boundary. Bun remains a development package manager.

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
      packages/node/src
      toolset + CLI adapters
              |
              v
 packages/native/* + root npm package
```

Dependencies point downward only. Nothing below the public adapters imports
JavaScript, and no JavaScript module owns HTTP, XML, fallback, or source-domain
rules.

## Components and start-here paths

- [`contracts/kisnet/openapi.yaml`](contracts/kisnet/openapi.yaml) — sole
  authority for external HTTP and serialized Nexacro facts, including the
  named profile for constraints OpenAPI cannot express directly.
- [`crates/ytm-core`](crates/ytm-core) — prepared requests, bounded transport,
  strict XML parsing, kind resolution, matrix normalization, date fallback,
  and tagged errors. It is independent of Node-API types.
- [`crates/ytm-node`](crates/ytm-node) — async `matrix` and `kinds` projection,
  cancellation, capabilities, and stable error data. It contains no source
  rules.
- [`packages/node/src`](packages/node/src) — wire-ignorant public validation,
  help, CLI parsing, and stdout rendering.
- [`packages/native`](packages/native) — generated platform package manifests;
  release builds add exactly one Node-API artifact to each package.
- [`judge`](judge) — process-isolated public-product conformance scenarios. It
  never imports conformer internals.
- [`native-targets.json`](native-targets.json) — canonical support matrix and
  source for optional dependencies, native manifests, loader selection, and CI.
- [`docs/provider-qualification.md`](docs/provider-qualification.md) — source
  evidence and enablement decisions that protocol tests cannot establish.

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
   dependency errors, or panics. The adapter renders the public result.

## Ownership and invariants

- OpenAPI and its named Nexacro profile are the only wire authority. Fixtures
  and judge expectations are independent evidence.
- Rust is the only component allowed to know source origins, paths, headers,
  serialized XML, transport policy, parser rules, or dataset mappings.
- The Node-API surface is asynchronous and project-owned. Rust crate types,
  parser types, raw bodies, dependency errors, and panics do not cross it.
- The public toolset accepts `AbortSignal` cancellation and has no JavaScript
  transport-injection seam.
- Judge builds enable a compile-time-only Rust fixture transport. Release
  builds cannot enable or select it, and clean-install tests exercise release
  artifacts separately.
- Rust returns source metadata and the canonical kind capability projection.
  JavaScript owns public input-shape constants, not source facts or the kind
  catalog.
- Discovery may add kinds but cannot remove or redefine canonical values;
  conflicts fail explicitly.
- Transport is sequential, bounded, redirect-free, proxy-free, and has no
  automatic retry. Date fallback advances only after confirmed empty data.
- Matrix lookup performs initialization followed by retrieval for each date.
  The maximum fallback window permits 32 dates and 64 sequential HTTP calls,
  each with its own 20-second deadline; cancellation is the overall stop.
- Stable project error categories and recovery metadata cross adapters;
  dependency messages do not.
- Native manifests, the loader, optional dependencies, and built JavaScript
  files are generated or compared deterministically before delivery.

## Runtime and native distribution

Node.js 22 is the minimum runtime. CI also validates Node 24 and 26.

Supported native targets are Linux GNU x64/ARM64, macOS ARM64, and Windows x64.
Each target is built on its native Blacksmith image and clean-installs the
packed root and platform packages under all three Node majors. Intel macOS,
Linux musl, Windows ARM64/ia32, FreeBSD, Android, and WASM are unclaimed.

The root npm package contains JavaScript only and selects an exact-version
optional native package at runtime. Platform packages contain one `.node`
artifact and are not public entry points.

## Release boundary

No workflow creates release PRs, tags, or GitHub Releases. Release Please and
the Python release path are absent. A future authorized `node-vX.Y.Z` tag makes
`release.yml` build all four native packages on their native Blacksmith images,
validate and pack the root package, then publish native packages before the
root from npm's required GitHub-hosted OIDC runner.

The current `0.2.0` version remains historical until a new version is
explicitly approved. Publication, PyPI deprecation, provider-state changes,
and the final main-branch merge remain separate authority boundaries.
