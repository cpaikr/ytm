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

Dependencies point inward toward `ytm-core`. The Node SDK, Python SDK, and Rust CLI are
sibling consumers; neither depends on the other. The npm package has no
executable entry, and the repository supports only the Rust `ytm` CLI.

## Components and start-here paths

- [`contracts/kisnet/openapi.yaml`](contracts/kisnet/openapi.yaml) — sole
  authority for external HTTP and serialized Nexacro facts, including the
  named profile for constraints OpenAPI cannot express directly.
- [`crates/ytm-core`](crates/ytm-core) — public Rust SDK. It owns prepared
  requests, bounded transport, strict XML parsing, kind resolution,
  normalization, date fallback, history orchestration, typed inputs and results, source metadata, and
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
  local and CI builds add exactly one Node-API artifact to each package.
- [`judge`](judge) — process-isolated public-product conformance scenarios for
  the Node SDK and Rust CLI. It does not import core internals.
- [`native-targets.json`](native-targets.json) — canonical Node native support
  matrix and source for optional dependencies, manifests, loader selection,
  and CI.
- [`python-targets.json`](python-targets.json) — Python native and interpreter
  matrix shared by local and CI wheel candidates.
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

History is a core operation, not an adapter loop over `matrix`. The core
normalizes the bounded date selection, discovers each requested date's catalog,
and resolves every date/kind pair sequentially. Invocation-local caches share
confirmed dated catalogs and date/kind observations across overlapping fallback
windows and evict observations outside future windows. Count selection uses the
same full-day retrieval with a backward exact scan, qualifies dates by numeric
yields, and drops each candidate's cache before moving earlier. Only accepted
days survive, then whole day groups are ordered ascending. They never persist data
or convert operational failures into absence. Result entries preserve each
requested pair even when observations are reused. The [history contract](SPEC.md#multi-date-history)
owns selection limits, availability, ordering, and fallback semantics.

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
- Judge builds may enable a compile-time-only replacement fixture transport or
  route the real HTTP client to a validated numeric loopback origin. Release
  builds cannot enable or select either seam; clean consumers exercise release
  artifacts separately.
- Discovery may add kinds but cannot remove or redefine canonical values;
  conflicts fail explicitly.
- `ytm-core` invokes transports sequentially. `YtmService` owns one invocation
  `RetrievalContext`, its deadline, child cancellation token, shared statistics
  and date/category enrichment. A single-use pull progress handle exposes coalesced snapshots
  without callbacks or an event queue. `HttpTransport` owns physical attempt
  eligibility, configured replay and combined pacing/retry waits
  under the [bounded recovery contract](SPEC.md#bounded-retrieval-recovery).
  Redirects and proxies remain disabled; date fallback advances only on
  confirmed empty data.
- The public `Transport::post` and `PreparedRequest` shapes remain stable. A
  default `post_with_context` hook delegates to existing custom implementations;
  the service bounds their asynchronous future without retrying it. Decorators,
  including CLI progress, forward the context-aware hook. SDKs and CLI read the
  same core counters; Python task cancellation drains native work before exposing
  final statistics. HTTP attempt identity remains invocation-local until that lookup's parsing/normalization completes,
  preserving error metadata without changing the transport response type.
- Matrix fallback permits 32 dates and 64 logical lookups. Bounded retries may
  add physical attempts; one shared retrieval budget spans the entire traversal.
  Python begins this budget after its client queue, and CLI export stays outside
  it. Expiry cancels only the invocation child; caller cancellation takes priority.
- Stable project error categories and recovery metadata cross adapters;
  dependency messages do not.
- Native manifests, the loader, optional dependencies, and built JavaScript
  files are generated or compared deterministically before delivery.

## Runtime and distribution boundaries

The SDKs and CLI have separate distribution boundaries over the same core:

| Surface | Canonical support matrix | Distribution |
| --- | --- | --- |
| Node SDK | [`native-targets.json`](native-targets.json) | JavaScript facade with exact-version optional Node-API packages; private development packages. |
| Python SDK | [`python-targets.json`](python-targets.json) | Typed facade and PyO3 extension in portable `cp311-abi3` mixed wheels; development artifacts. |
| Standalone CLI | [`cli-targets.json`](cli-targets.json) | Native executable archives, generated installers, and checksums on GitHub Releases. |

The matrices own runtime versions, native targets, and platform floors.
Overlapping runner, architecture, and Linux toolchain facts are mechanically
reconciled while the support matrices may evolve independently. SDK consumers
load native code in process; they do not invoke the CLI. Historical registry
packages expose earlier APIs and remain unchanged.

Candidate builders normalize package contents and metadata. Full-platform CI
installs the exact aggregated artifacts on their declared native targets without
rebuilding them. Python wheel evidence additionally binds reproducible bytes,
native identity, typing, and legal notices to the source commit. Fixture builds
exercise injected source behavior separately from clean release consumers.
The [release runbook](docs/release.md) owns build procedures and certification.

## Installation and release isolation

Generated installers own fresh-install and managed-replacement transactions.
They publish an executable and adjacent receipt as a verified pair. The CLI's
[`release_management.rs`](crates/ytm-cli/src/release_management.rs) derives its
platform identity from the CLI matrix at build time and contacts GitHub Releases
only for an explicit `upgrade` command. It verifies local identity, release
metadata, checksums, and installer bytes before delegating replacement.

Unix replacement uses a transaction with fixed recovery files. Windows uses an
out-of-process PowerShell helper so the running executable can exit before
replacement. Interrupted transactions retain evidence and fail closed; the
[public upgrade contract](SPEC.md#public-sdk-and-cli-surfaces) owns receipt,
status, and recovery semantics. History, matrix, kinds, help, and version do not
depend on release infrastructure.

Local `release-it` synchronizes the product version and prepares the changelog
and tag. The manually dispatched release workflow certifies an immutable tag
reachable from `main`, then gives only the publisher write access to publish the
exact verified CLI candidate. Branch dispatch certifies without publishing.
Draft recovery is additive and byte-identical; public assets are immutable.
Node and Python artifacts are outside this publication pipeline.

`bun run validate` is the shared uncredentialed gate for local development,
automatic CI, and tagged-source verification. Credentialed live source checks
are a separate operational boundary. The [release runbook](docs/release.md)
owns CI coverage, publication procedures, and recovery; the
[roadmap](ROADMAP.md) routes remaining verification and decisions.
