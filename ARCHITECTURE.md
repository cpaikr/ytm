# Architecture

## Purpose and boundary

`ytm` retrieves deterministic KIS-NET YTM Matrix data through one Rust HTTP,
Nexacro, and domain implementation. The active checkout exposes that
implementation as a public Rust SDK, Rust-backed Node and Python SDKs, and a
standalone Rust/Clap CLI. The Node package does not own or distribute the CLI.

[`SPEC.md`](SPEC.md) defines public behavior. [`ROADMAP.md`](ROADMAP.md) owns
remaining verification and future decision boundaries; it is not an account of
implemented architecture.

Browser, edge, Deno, Bun-runtime, proxy discovery, and alternate
provider implementations are outside the product boundary. Bun remains a
development package manager for the Node workspace.

## System shape

The implemented shape is:

```text
contracts/kisnet/openapi.yaml
              |
       crates/ytm-core
       public Rust SDK
        /     |      \
  ytm-node  ytm-cli  ytm-python
     |        |         |
 Node SDK  Rust CLI  Python SDK
```

Dependencies point downward toward `ytm-core`. The Node SDK, Python SDK, and Rust CLI are
sibling consumers; neither depends on the other. The npm package has no
executable entry, and the repository supports only the Rust `ytm` CLI.

## Components and start-here paths

- [`contracts/kisnet/openapi.yaml`](contracts/kisnet/openapi.yaml) — sole
  authority for external HTTP and serialized Nexacro facts, including the
  named profile for constraints OpenAPI cannot express directly.
- [`crates/ytm-core`](crates/ytm-core) — public Rust SDK. It owns prepared
  requests, bounded transport, strict XML parsing, kind resolution,
  normalization, date fallback, typed inputs and results, source metadata, and
  tagged errors without Node-API or CLI types.
- [`crates/ytm-node`](crates/ytm-node) — async Node-API projection over the
  public Rust SDK. It owns JavaScript cancellation and stable boundary
  serialization, but no source rules.
- [`packages/node/src`](packages/node/src) — public Node SDK validation, typed
  client interface, type declarations, and error ergonomics. It has no CLI
  adapter.
- [`crates/ytm-python`](crates/ytm-python) — private PyO3 binding over the
  public Rust SDK, with process-shared Tokio runtime, cancellation and draining.
- [`packages/python`](packages/python/README.md) — typed `Client`/`AsyncClient`,
  immutable values, stable errors, and mixed-wheel packaging. The
  [Python API contract](packages/python/SPEC.md) owns lifecycle details.
- [`crates/ytm-cli`](crates/ytm-cli) — workspace crate producing the standalone `ytm`
  binary. It owns Clap parsing, command help, terminal diagnostics, tabular
  rendering, Excel workbook publication, and exit statuses while delegating
  product behavior to `ytm-core`. Private `table.rs` owns the shared typed
  projection; `xlsx.rs` owns workbook layout, provenance, and file publication.
- [`packages/native`](packages/native) — generated platform package manifests;
  Node release builds add exactly one Node-API artifact to each package.
- [`judge`](judge) — process-isolated public-product conformance scenarios for
  the Node SDK and Rust CLI. It does not import core internals.
- [`native-targets.json`](native-targets.json) — canonical Node native support
  matrix and source for optional dependencies, manifests, loader selection,
  and CI.
- [`python-targets.json`](python-targets.json) — Python native and interpreter
  matrix shared by CI and tagged wheel candidates.
- [`cli-targets.json`](cli-targets.json) — independent standalone CLI support
  matrix and source for archive names, installer selection, and CLI artifact CI.
- [`docs/provider-qualification.md`](docs/provider-qualification.md) — source
  evidence and enablement decisions that protocol tests cannot establish.

## Runtime flows

For a Rust SDK call or Rust CLI command:

1. The caller or Clap adapter constructs a typed SDK request.
2. `ytm-core` validates domain input, resolves the canonical kind, prepares the
   contract-defined request, and performs one bounded source call at a time.
3. Rust enforces transport and XML constraints before interpreting protocol
   status or datasets, then returns typed domain data and source metadata.
4. Only confirmed unavailable data can advance previous-date fallback.
5. The SDK returns typed results or tagged errors; the CLI projects them to the
   approved JSON, CSV, TSV, XLSX receipt, diagnostic, and exit-code contract.

For XLSX, the CLI validates the destination before source execution, projects
one typed result through the same table model as CSV/TSV, and renders the
workbook in memory with `rust_xlsxwriter`. `tempfile` stages and syncs the
complete bytes in the destination directory and closes the file handle before
no-clobber publication or explicit replacement. Success reaches textual stdout
only after publication. Export failures stay in the CLI and cannot re-enter
core fallback. These dependencies belong only to the CLI; sibling SDKs retain
their existing result and dependency boundaries. The [Excel contract](SPEC.md#cli-excel-export)
owns cells, provenance, and observable failure guarantees.

For a Node SDK call:

1. The JavaScript adapter performs network-free public-shape validation and
   forwards normalized input plus `AbortSignal` cancellation to Node-API.
2. The binding calls the same public Rust SDK used by the CLI and projects its
   result without raw bodies, dependency errors, or panics.
3. The Node adapter returns the typed client result or stable JavaScript
   error. It does not render or dispatch a command-line interface.

For a Python SDK call, the facade checks Python shapes and the private binding
constructs the public Rust request. Sync execution releases the interpreter;
async execution uses the maintained PyO3 Tokio bridge. Each client serializes
calls and owns a cancellation root. Close cancels and drains calls before
releasing its service. Per-call cancellation leaves the client usable. Panics
are contained during calls and individual async polls; a chained hook suppresses
only diagnostics within those boundaries.

## Ownership and invariants

- OpenAPI and its named Nexacro profile are the only wire authority. Fixtures
  and judge expectations are independent evidence.
- Rust is the only component allowed to know source origins, paths, headers,
  serialized XML, transport policy, parser rules, dataset mappings, or fallback
  execution and source semantics. The Node, Python, and CLI boundaries may project the
  public fallback inputs and validate them before calling the SDK.
- `ytm-core` exposes caller-facing requests, results, capabilities, source
  metadata, and errors from its crate root. Node runtime requirements and CLI
  presentation types stay outside the SDK.
- `ytm-node`, `ytm-python`, and `ytm-cli` consume the public SDK boundary.
  They may project runtime-specific cancellation and presentation concerns but
  may not call private parser, request, or transport modules.
- There is one supported `ytm` executable: the Rust/Clap binary. The npm
  package has no `bin` entry or JavaScript CLI compatibility implementation.
- The Node-API surface remains asynchronous and project-owned. Rust crate
  internals, parser types, raw bodies, dependency errors, and panics do not
  cross it.
- The public Node SDK accepts `AbortSignal` cancellation and has no JavaScript
  transport-injection seam.
- Judge builds may enable a compile-time-only Rust fixture transport. Release
  builds cannot enable or select it, and clean-consumer tests exercise release
  artifacts separately.
- Discovery may add kinds but cannot remove or redefine canonical values;
  conflicts fail explicitly.
- `ytm-core` invokes transports sequentially. Its default `HttpTransport` is
  deadline-bounded, redirect-free, proxy-free, and has no automatic retry;
  custom `Transport` implementations own equivalent transport policy. Date
  fallback advances only after confirmed empty data.
- Matrix lookup performs initialization followed by retrieval for each date.
  The maximum fallback window permits 32 dates and 64 sequential transport
  invocations. With the default `HttpTransport`, each call has its own 20-second
  deadline and cancellation is the overall stop.
- Stable project error categories and recovery metadata cross adapters;
  dependency messages do not.
- Native manifests, the loader, optional dependencies, and built JavaScript
  files are generated or compared deterministically before delivery.

## Runtime and distribution boundaries

The current Node SDK requires Node.js 22; CI also validates Node 24 and 26.
Supported Node native targets are Linux GNU x64/ARM64, macOS ARM64, and Windows
x64. Linux artifacts are cross-linked against an explicit glibc 2.28 floor;
their versioned ELF requirements are checked before packaging. Each target is
built on a native runner during full-platform validation and clean-installed
under all three Node majors. The root npm package contains JavaScript only and
selects an exact-version optional native package at runtime.

[`cli-targets.json`](cli-targets.json) independently owns the standalone CLI
support matrix: GNU/Linux x64 and ARM64 at the shared glibc 2.28 floor, macOS
ARM64, and Windows x64. The Node and CLI matrices may evolve independently;
overlapping runner, architecture, and Linux toolchain facts are mechanically
reconciled. Full-platform CI builds the exact target binary on a native
runner, executes its version and help identity, creates a normalized archive,
and aggregates all four archives with generated shell and PowerShell installers
plus sorted SHA-256 metadata. Repository-owned packers normalize archive order,
timestamps, ownership, modes, and ZIP metadata; exact-content validation
rejects undeclared or private files. A downstream native matrix downloads that
single aggregate without rebuilding it, installs through the generated shell or
PowerShell entrypoint, and verifies exact executable, receipt, command identity,
integrity rejection, and managed replacement on every claimed target. Bounded
single-anchor copies of the already-validated installer inject transaction and
Windows status-publication faults and verify rollback or retained recovery
evidence without adding a test-only runtime seam to published artifacts.

The generated installers now write a strict adjacent executable receipt and own
fresh-install and managed-replacement transactions. The CLI's isolated release
management module derives its platform identity from `cli-targets.json` at
build time, validates the installed pair, and checks GitHub Releases only for
an explicit `upgrade` command. It verifies release metadata, checksums, and the
generated installer before delegating archive download and replacement. Unix
uses an installer transaction with fixed recovery links; Windows uses an
out-of-process PowerShell helper so the running mapped executable can exit
before replacement. Matrix, kinds, help, and version execution do not depend on
release infrastructure. Exact installed candidates also exercise network-free
XLSX export, overwrite policy, and native publication failures; the judge owns
full workbook semantics through an independent test-only ZIP/XML inspector.

The disabled tagged-source workflow rebuilds these outputs from one immutable
approved tag and attaches them only after exact native-consumer validation. No
public installer URL is active. Selecting or publishing an actual version
remains separately authorized release work.

The Python facade uses PyO3's `abi3-py311` boundary and the maintained Tokio
bridge. `python-targets.json` drives the shared CI/tagged workflow for native
builds, complete aggregation, and exact consumers. Fresh builds must produce
identical wheel bytes; integrity validation binds those bytes, native identity,
typing, and legal notices to the source commit. Consumers install outside the
checkout without a Rust toolchain. Separate fixture builds own injected source,
cancellation, and panic evidence; release wheels cannot select those facilities.

## Release boundary

[`docs/release.md`](docs/release.md) is the canonical release-state, CI platform
coverage, and publication runbook.

`bun run validate` owns the complete uncredentialed repository gate. Local
development, ordinary CI, and immutable tagged-source validation delegate to
that same command; credentialed live source checks remain a separate
operational boundary.

The disabled Release Please preparation workflow owns one root product release
PR, `VERSION`, and the root changelog; it explicitly skips tag and GitHub
Release creation. A separately gated publication workflow accepts only the
approved version at the merged PR head, creates exactly its changelog-derived
`vX.Y.Z` tag and draft, and rebuilds and consumes every CLI, npm, and Python
candidate from that SHA. A unified asset manifest binds the complete canonical
set before visibility. npm and independently gated PyPI project those downloaded
bytes through OIDC after GitHub becomes public. Draft recovery is additive and
byte-identical; public recovery preserves exact completed projections and permits
only wholly absent projections. Partial or conflicting versions fail closed.

The registry release at `0.2.0` predates the rewrite; the checkout retains that
version until a new release is authorized. The SDK/CLI migration does not
authorize crates.io publication, npm publication, CLI binaries or installers,
GitHub Releases, provider-state changes, or PyPI deprecation.
