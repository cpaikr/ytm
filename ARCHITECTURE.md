# Architecture

## Purpose and lifecycle

`ytm` retrieves deterministic KIS-NET YTM Matrix data through one Rust HTTP,
Nexacro, and domain implementation. The active checkout exposes that
implementation as a public Rust SDK and through a Rust-backed Node SDK. A
JavaScript CLI remains temporarily while a separate Rust/Clap executable is
implemented and verified.

[`plans/rust-sdk-node-sdk-rust-cli.md`](plans/rust-sdk-node-sdk-rust-cli.md)
owns the remaining migration boundary and completion criteria. Current commands
and package behavior remain defined by [`SPEC.md`](SPEC.md).

Python, browser, edge, Deno, Bun-runtime, proxy discovery, and alternate
provider implementations are outside the product boundary. Bun remains a
development package manager for the Node workspace.

## System shape

The implemented transition shape is:

```text
contracts/kisnet/openapi.yaml
              |
              v
       crates/ytm-core
       public Rust SDK
              |
              v
       crates/ytm-node
       Node-API boundary
              |
              v
      packages/node/src
      Node toolset + JS CLI
```

The approved target shape is:

```text
contracts/kisnet/openapi.yaml
              |
              v
       crates/ytm-core
       public Rust SDK
          /         \
         v           v
crates/ytm-node   crates/ytm-cli
 Node-API         Clap binary
    |                 |
    v                 v
packages/node       `ytm`
  Node SDK        standalone CLI
```

Dependencies point downward toward `ytm-core`. The Node SDK and Rust CLI are
sibling consumers; neither depends on the other. At migration completion the
npm package has no executable entry and the repository supports only the Rust
`ytm` CLI.

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
- [`packages/node/src`](packages/node/src) — public Node SDK validation,
  discovery, type declarations, and error ergonomics. Its current CLI adapter
  is removed after the Rust CLI reaches parity.
- `crates/ytm-cli` — planned workspace crate producing the standalone `ytm`
  binary. It owns Clap parsing, command help, terminal diagnostics, tabular
  rendering, and exit statuses while delegating product behavior to
  `ytm-core`.
- [`packages/native`](packages/native) — generated platform package manifests;
  Node release builds add exactly one Node-API artifact to each package.
- [`judge`](judge) — process-isolated public-product conformance scenarios.
  During migration it must test the Node SDK and Rust CLI independently without
  importing core internals.
- [`native-targets.json`](native-targets.json) — canonical Node native support
  matrix and source for optional dependencies, manifests, loader selection,
  and CI.
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
   approved JSON, CSV, TSV, diagnostic, and exit-code contract.

For a Node SDK call:

1. The JavaScript adapter performs network-free public-shape validation and
   forwards normalized input plus `AbortSignal` cancellation to Node-API.
2. The binding calls the same public Rust SDK used by the CLI and projects its
   result without raw bodies, dependency errors, or panics.
3. The Node adapter returns the typed toolset result or stable JavaScript
   error. It does not render or dispatch a command-line interface.

The current JavaScript CLI remains a temporary adapter over the Node toolset
until the Rust CLI satisfies the same black-box contract.

## Ownership and invariants

- OpenAPI and its named Nexacro profile are the only wire authority. Fixtures
  and judge expectations are independent evidence.
- Rust is the only component allowed to know source origins, paths, headers,
  serialized XML, transport policy, parser rules, dataset mappings, or
  fallback policy.
- `ytm-core` exposes caller-facing requests, results, capabilities, source
  metadata, and errors from its crate root. Node runtime requirements and CLI
  presentation types stay outside the SDK.
- In the target shape, `ytm-node` and `ytm-cli` consume the public SDK boundary.
  They may project runtime-specific cancellation and presentation concerns but
  may not call private parser, request, or transport modules.
- There is one supported `ytm` executable. The npm `bin` entry and JavaScript
  CLI are removed only after Rust CLI parity is proven; they are not retained
  as a compatibility implementation.
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
- Transport is sequential, bounded, redirect-free, proxy-free, and has no
  automatic retry. Date fallback advances only after confirmed empty data.
- Matrix lookup performs initialization followed by retrieval for each date.
  The maximum fallback window permits 32 dates and 64 sequential HTTP calls,
  each with its own 20-second deadline; cancellation is the overall stop.
- Stable project error categories and recovery metadata cross adapters;
  dependency messages do not.
- Native manifests, the loader, optional dependencies, and built JavaScript
  files are generated or compared deterministically before delivery.

## Runtime and distribution boundaries

The current Node SDK requires Node.js 22; CI also validates Node 24 and 26.
Supported Node native targets are Linux GNU x64/ARM64, macOS ARM64, and Windows
x64. Each target is built on its native GitHub-hosted image and clean-installed
under all three Node majors. The root npm package contains JavaScript only and
selects an exact-version optional native package at runtime.

The standalone Rust CLI must build and pass black-box tests as a workspace
binary. Its publication targets, installers, release assets, and support matrix
are not implied by the Node native matrix and require a separate release
decision.

## Release boundary

No workflow creates release PRs, tags, or GitHub Releases. Release Please and
the Python release path are absent. The retained Node workflow publishes native
packages before the root npm package through OIDC only after separate version,
tag, dispatch, and environment approval.

The current `0.2.0` version remains historical. The SDK/CLI migration does not
authorize crates.io publication, npm publication, CLI binaries or installers,
GitHub Releases, provider-state changes, or PyPI deprecation.
