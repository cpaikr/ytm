# Deliver a Rust SDK, Rust-backed Node SDK, and standalone Rust CLI

## Outcome

`ytm` ships three deliberately separated products over one Rust domain and
protocol implementation: a consumable Rust SDK, a Node SDK backed by that Rust
SDK through Node-API, and a standalone `ytm` executable built in Rust with
Clap. The Node package no longer owns or distributes the CLI.

## Delivered state

- `crates/ytm-core` owns KIS-NET transport, Nexacro parsing, normalization,
  fallback, capabilities, and errors, and `crates/ytm-node` already depends on
  it. This is the correct dependency direction.
- PR #16 promoted `ytm-core` to a typed public SDK with crate-root
  result/source re-exports, validated date/kind/fallback inputs, a default HTTP
  client, token-free ordinary calls, explicit cancellation and transport
  seams, crate docs, examples, public-API tests, and a detached consumer check.
- `@sjunepark/ytm/toolset` is the Node SDK surface and calls the native Rust
  binding. The npm package has no `bin` entry or JavaScript CLI source.
- `crates/ytm-cli` is the standalone Rust/Clap `ytm` binary. Its parser,
  validation projection, help, JSON/CSV/TSV rendering, diagnostics, and exit
  statuses match the approved black-box contract while execution calls only
  the public `ytm-core` SDK.
- The public judge runs the standalone CLI and Node SDK independently across
  95 scenarios. It adds explicit CLI fallback, malformed-source,
  argv-ordered input merge, and unknown-command coverage while preserving the
  previously reviewed CLI goldens, including legacy-anchored invalid-invocation
  payloads. Review hardening also freezes missing JSON required fields and
  JavaScript-compatible integral numeric kinds.
- PR #15 merged as `77c33fd` after required validation and all 12 native
  consumer jobs passed. Issues #13 and #7 are closed; their kind-80,
  padded-yield, raw-fidelity, and fail-closed behavior is established baseline
  behavior that every new surface must preserve.

## Decisions

- Treat `crates/ytm-core` as the public Rust SDK instead of adding a facade
  crate. Keep provider and domain behavior there and make its public API
  ergonomic for ordinary Rust callers.
- Add `crates/ytm-cli` as a separate workspace member. It produces the `ytm`
  binary, uses Clap for commands and flags, and depends only on the public
  `ytm-core` API for product behavior.
- Keep `crates/ytm-node` as a thin Node-API adapter over the same public SDK.
  The JavaScript/TypeScript package remains responsible for Node ergonomics,
  type declarations, `AbortSignal` projection, and toolset discovery, but not
  HTTP, XML, fallback, domain policy, or CLI behavior.
- Remove the npm `bin` entry and JavaScript CLI after the Rust CLI reaches
  behavioral parity. Do not retain two supported `ytm` executables.
- Preserve the current command names, accepted inputs, deterministic
  JSON/CSV/TSV output, structured failures, stdout/stderr rules, exit statuses,
  kind catalog, fallback behavior, and provenance fields unless the migration
  exposes an unavoidable incompatibility that is explicitly reviewed.
- Keep OpenAPI as the sole wire authority and the Rust core as the sole KIS-NET
  conformer. The SDK and CLI must not create alternate transport or parsing
  implementations.
- Keep the existing four-target Node native matrix. Rust CLI publication,
  installer formats, GitHub Releases, crates.io publication, npm publication,
  version selection, and tags remain separate release decisions.

## Included results

### Public Rust SDK

- Re-export every caller-facing request, result, row, capability, source, and
  error type from the crate root.
- Replace JSON-shaped or stringly public concepts with the smallest practical
  Rust types while retaining serialization compatibility at the Node boundary.
- Provide a straightforward default HTTP client/service construction path and
  an explicit advanced injection seam for deterministic tests.
- Remove Node-only capability data from `ytm-core`; project it in the Node
  adapter or package instead.
- Add crate-level documentation, runnable examples, public-API tests, and a
  clean external Rust consumer check.

### Rust-backed Node SDK

- Make `ytm-node` consume only the public `ytm-core` SDK boundary; no private
  or CLI-specific behavior crosses Node-API.
- Retain the typed `@sjunepark/ytm/toolset` SDK and native package loader while
  removing the npm executable and JavaScript CLI implementation.
- Keep Node 22/24/26 and the four declared native targets covered by clean
  package-consumer tests.

### Standalone Rust CLI

- Add `ytm-cli` with Clap subcommands for `matrix`, `kinds`, and help.
- Reproduce the approved JSON, pretty JSON, CSV, TSV, diagnostic, and exit-code
  contracts using Rust SDK results and errors.
- Add black-box binary scenarios, including kind 80, padded numeric cells,
  exact raw fidelity, missing tenors, fallback, malformed source data, and
  invalid invocations.
- Make repository smoke and CLI examples invoke the Rust binary. Keep Node SDK
  tests focused on the in-process SDK surface.

### Documentation and delivery readiness

- Reconcile the architecture, product contract, root and package READMEs,
  agent skill, judge documentation, validation scripts, and release boundary
  with the three-product split.
- Keep generated artifacts and native manifests deterministic and add
  freshness checks for any projected CLI or SDK contract data.
- Complete repository-level review and all established Rust, Node, contract,
  package, judge, and supported-target checks before delivery.

## Resolved implementation decision

Ordinary Rust SDK calls are token-free. Explicit
`kinds_with_cancellation`/`matrix_with_cancellation` methods retain Tokio
cancellation for the Node `AbortSignal` projection and the future CLI
interruption path. The `with_transport` seam is similarly advanced rather than
required for ordinary construction.

## Completion criteria

- An external Rust consumer can depend on `ytm-core`, construct the default
  client, call `kinds` and `matrix`, handle typed results and errors, and build
  from documented examples without using Node or crate-private paths.
- The Node package exposes the Rust-backed SDK and has no `bin` entry,
  JavaScript CLI entry point, or alternate provider implementation.
- `cargo run -p ytm-cli -- ...` and the built `ytm` binary satisfy the approved
  CLI contract across deterministic fixtures and a bounded metadata-only live
  smoke.
- Rust SDK, Node SDK, and CLI depend toward one Rust implementation; behavior
  shared by the three surfaces is tested once at the core and projected at
  adapter boundaries.
- Formatting, Clippy, Rust tests, contract validation, public-surface judge,
  deliberate broken-oracle check, package checks, external Rust consumer, and
  all 12 Node native consumers pass on the final reviewed revision.
- Planning and current-state documentation are truthful, and delivery finishes
  through the selected PR lifecycle.

## Out of scope

- crates.io, npm, binary, installer, tag, or GitHub Release publication.
- Selecting a new version or designing the final cross-platform CLI release
  channel.
- Reintroducing Python, adding browser/edge/Deno/Bun-runtime support, or adding
  another HTTP/XML implementation.
- Changing provider qualification or production enablement.

## Delivery

- PR #16 delivered the consumable public Rust SDK to the integration branch.
- PR #17 delivers the standalone Rust CLI, removes CLI ownership and
  distribution from the Node package, and completes the cross-surface
  validation and documentation result.
- The final revision passes formatting, strict workspace Clippy, Rust unit,
  public-API and documentation tests, the detached Rust consumer, contract and
  release validation, the 95-scenario full judge, the 66-scenario Node-only
  judge, deliberate-oracle corruption, npm package inspection, and all 12
  supported native consumer jobs. Publication and release-channel decisions
  remain excluded.
