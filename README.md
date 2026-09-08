# KIS-NET YTM

KIS-NET YTM Matrix access backed by one Rust HTTP, Nexacro, and domain core.
The current checkout exposes that core as a public Rust SDK, through a
Rust-backed Node SDK, typed sync/async Python clients, and a standalone
Rust/Clap CLI. The Node package
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

Build and run the checked-out source for the current SDK APIs; historical
registry releases predate this implementation. CLI publication follows the
[release runbook](docs/release.md).

```sh
bun install --frozen-lockfile
bun run build
bun run cli -- matrix --base-date 2026-06-08 --kind 국채 --format json
bun run cli -- kinds --format json
```

`bun run cli --` invokes the Rust binary. The Node package requires Node.js 22
or newer and exports a root `YtmClient` for in-process use, but it has no
executable entry. Its GNU/Linux x64 and ARM64 artifacts target glibc 2.28 or
newer. Run `bun run cli -- --help` and
`bun run cli -- <command> --help` for the checkout CLI contract. See
[`SPEC.md`](SPEC.md) for product behavior and
[`docs/provider-qualification.md`](docs/provider-qualification.md) before
treating source availability as production suitability.

Save an Excel workbook from the checkout:

```sh
bun run cli -- matrix --base-date 2026-06-08 --kind 국채 --format xlsx --output yields.xlsx
bun run cli -- kinds --format xlsx --output kinds.xlsx
bun run cli -- history --end-date 2026-09-08 --count 180 --format xlsx --output history.xlsx
```

`history --end-date 2026-09-08 --count 180` retrieves the latest 180 distinct
dates with numeric yields across all categories and pricing groups. Missing
cells and unavailable categories remain visible; the count applies to dates,
not each series. It scans at most 2,000 calendar days and fails without an export
if the count cannot be met. Optional `--start-date` sets a hard lower boundary.

History also accepts an inclusive date range or repeated `--base-date` values,
up to 2,000 dates. These fixed selections use exact dates by default; explicit `--fallback previous-available` resolves each date/category
pair independently. Unavailable pairs remain visible in the result. Its Excel
workbook contains `History`, `Availability`, and `Metadata` sheets. See the
[history contract](SPEC.md#multi-date-history) for ordering, limits, and errors.

Use the default exact-date mode for historical exports and statistical analysis.
Enable `--fallback previous-available` only when you want the latest available
observation on or before each requested date, within the configured lookback.
Fallback can repeat one observation across several requested dates—for example,
Friday's data for Saturday and Sunday—so those rows are not new observations.
In CSV/TSV and Excel, `requestedBaseDate` identifies the requested date,
`baseDate` identifies the observation date, and `usedFallback` marks a substitution.

The parent directory must exist. Existing files require `--overwrite`; stdout
returns a JSON receipt after the workbook is saved. Workbooks preserve numeric
yields, blank missing values, literal Korean labels, and a separate provenance
sheet. Excel is not required to export. See the [Excel contract](SPEC.md#cli-excel-export)
for file safety and typed-cell details.

The standalone binary also exposes an exact, network-free identity:

```sh
bun run cli -- --version
```

[Full-platform CI](docs/release.md#ci-platform-policy) builds deterministic
standalone CLI candidates for GNU/Linux x64 and ARM64
(glibc 2.28 or newer), macOS ARM64, and Windows x64. Each candidate contains
one versioned archive per target, `install.sh`, `install.ps1`, and sorted
`SHA256SUMS`; [`cli-targets.json`](cli-targets.json) owns that support surface.
The generated installers verify their selected archive, publish a strict
adjacent executable receipt, and support explicit, recoverable managed upgrades
through `ytm upgrade` and the read-only `ytm upgrade --check`. Locally built or
modified executables are deliberately unmanaged. Native clean-consumer jobs
install the exact aggregated candidate on every claimed target and verify its
identity, receipt, integrity failures, managed replacement, and network-free
Excel export with overwrite and platform-specific publication failures. Transaction
faults are injected into bounded temporary installer copies to verify rollback
and recoverable failure evidence without shipping a test failpoint.

The tag-triggered release workflow certifies and publishes only these CLI
assets to GitHub Releases. Local `release-it` prepares the synchronized version
and changelog before committing, tagging, and pushing. See the
[release runbook](docs/release.md) for the publishing command and recovery policy.

The [Python package](packages/python/README.md) provides `Client` and
`AsyncClient` over the same core. Build its local mixed wheel with Python 3.11+
and Rust; historical PyPI 0.2.0 has a different API. The
[Python matrix](python-targets.json) drives portable `abi3` wheel builds and
exact development CI consumers for conventional CPython 3.11–3.14. Node packages
are private, and npm/PyPI publication is outside the release pipeline.

## Repository validation

```sh
cargo install --locked --features cli cargo-about --version 0.9.2
cargo install --locked cargo-audit --version 0.22.2
cargo install --locked cargo-deny --version 0.19.0
bun install --frozen-lockfile
PYO3_PYTHON="$(command -v python3.11)" bun run validate
```

`bun run validate` is the complete uncredentialed repository gate used by local
development, ordinary CI, and immutable tagged-source validation. It covers
contracts and generated files, version and release policy, formatting, linting,
Rust, Node, and Python consumers, dependency policy, conformance sensitivity, and
package contents. Python validation requires CPython 3.11+ with `venv`/`pip`;
`PYO3_PYTHON` selects the interpreter for Cargo and the wheel tests. The Python
gate builds isolated fixture and release wheels and checks the installed public
API and typing. Credentialed live source checks remain separate.

Live KIS-NET smoke checks are scheduled and manually dispatchable rather than
pull-request gates. The [release migration plan](plans/release-delivery.md)
records validation and delivery evidence. The [release runbook](docs/release.md)
explains protected-main preparation and tag publication.
