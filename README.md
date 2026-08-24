# KIS-NET YTM

KIS-NET YTM Matrix access backed by one Rust HTTP, Nexacro, and domain core.
The current checkout exposes that core as a public Rust SDK, through a
Rust-backed Node SDK, and through a standalone Rust/Clap CLI. The Node package
does not own or distribute the CLI.

[`SPEC.md`](SPEC.md) defines public behavior, while
[`ARCHITECTURE.md`](ARCHITECTURE.md) explains the implemented system shape.
[`ROADMAP.md`](ROADMAP.md) records the remaining verification and decision
boundaries.

## Run from this checkout

Run the documented Rust SDK example:

```sh
cargo run --locked -p ytm-core --example basic
```

Or use `ytm-core` through a path or Git dependency; its public API and typed
inputs are documented in [`crates/ytm-core`](crates/ytm-core/README.md).

Publication of the rewritten products is not yet authorized, so build and run
the checked-out source rather than historical registry releases.

```sh
bun install --frozen-lockfile
bun run build
bun run cli -- matrix --base-date 2026-06-08 --kind 국채 --format json
bun run cli -- kinds --format json
```

`bun run cli --` invokes the Rust binary. The Node package requires Node.js 22
or newer and exports `@sjunepark/ytm/toolset` for in-process use, but it has no
executable entry. Its GNU/Linux x64 and ARM64 artifacts target glibc 2.28 or
newer. Run `bun run cli -- --help` and
`bun run cli -- <command> --help` for the checkout CLI contract. See
[`SPEC.md`](SPEC.md) for product behavior and
[`docs/provider-qualification.md`](docs/provider-qualification.md) before
treating source availability as production suitability.

The standalone binary also exposes an exact, network-free identity:

```sh
bun run cli -- --version
```

CI builds deterministic standalone CLI candidates for GNU/Linux x64 and ARM64
(glibc 2.28 or newer), macOS ARM64, and Windows x64. Each candidate contains
one versioned archive per target, `install.sh`, `install.ps1`, and sorted
`SHA256SUMS`; [`cli-targets.json`](cli-targets.json) owns that support surface.
These CI artifacts are release inputs, not a public distribution channel.
No installer URL is documented until the tagged GitHub Release workflow is
implemented and an exact version is separately authorized.

## Repository validation

```sh
cargo install --locked --features cli cargo-about --version 0.9.2
cargo install --locked cargo-audit --version 0.22.2
cargo install --locked cargo-deny --version 0.19.0
bun install --frozen-lockfile
bun run validate
bun run build:check
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo test --locked -p ytm-core --doc
bun run rust:consumer:check
cargo audit
cargo deny check
bun run test
bun run judge:broken
bun run pack:node
```

Live KIS-NET smoke checks are scheduled and manually dispatchable rather than
pull-request gates. Release preparation, creation, and publication remain
disabled. Public GitHub Release distribution is an approved implementation
target in [`ROADMAP.md`](ROADMAP.md), but selecting or publishing an actual
version still requires separate authorization; see
[`docs/release.md`](docs/release.md).
