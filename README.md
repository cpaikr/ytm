# KIS-NET YTM

KIS-NET YTM Matrix access backed by one Rust HTTP, Nexacro, and domain core.
The current checkout exposes that core as a public Rust SDK and through a
Rust-backed Node SDK. The Node package still temporarily owns the JavaScript
CLI while the standalone Rust/Clap replacement is implemented and verified.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the implemented and target shapes
and [`plans/rust-sdk-node-sdk-rust-cli.md`](plans/rust-sdk-node-sdk-rust-cli.md)
for the remaining migration boundary.

## Run from this checkout

Run the documented Rust SDK example:

```sh
cargo run --locked -p ytm-core --example basic
```

Or use `ytm-core` through a path or Git dependency; its public API and typed
inputs are documented in [`crates/ytm-core`](crates/ytm-core/README.md).

The current CLI and Node SDK require Node.js 22 or newer:

Publication of the rewritten package is not yet authorized, so build and run
the checked-out source rather than the historical npm `latest` release.

```sh
bun install --frozen-lockfile
bun run build
bun run cli -- matrix --base-date 2026-06-08 --kind 국채 --format json
bun run cli -- kinds --format json
```

The package also exports `@sjunepark/ytm/toolset` for in-process use. Run
`ytm --help` and `ytm <command> --help` for the current CLI contract. See
[`SPEC.md`](SPEC.md) for product behavior and
[`docs/provider-qualification.md`](docs/provider-qualification.md) before
treating source availability as production suitability.

## Repository validation

```sh
bun install --frozen-lockfile
bun run validate
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
bun run rust:consumer:check
bun run test
bun run pack:node
```

Live KIS-NET smoke checks are scheduled and manually dispatchable rather than
pull-request gates. Release creation and publication remain disabled pending a
separate version and release decision; see [`docs/release.md`](docs/release.md).
