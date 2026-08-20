# KIS-NET YTM

Node.js access to the KIS-NET YTM Matrix, backed by a Rust HTTP and Nexacro
core. The JavaScript package is a thin CLI and runtime-neutral toolset; it does
not implement source transport or parsing.

## Run from this checkout

Node.js 22 or newer is required. Publication of the rewritten package is not
yet authorized, so build and run the checked-out source rather than the
historical npm `latest` release.

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
bun run test
bun run pack:node
```

Live KIS-NET smoke checks are scheduled and manually dispatchable rather than
pull-request gates. Release creation and publication remain disabled pending a
separate version and release decision; see [`docs/release.md`](docs/release.md).
