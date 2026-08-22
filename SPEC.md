# KIS-NET YTM Matrix Product Contract

## Capability

`ytm` retrieves KIS-NET YTM Matrix rows by `baseDate` (`기준일`) and
`kind` (`종류`). It reproduces the source protocol directly and does not drive
a browser.

## Authority and evidence

- [`contracts/kisnet/openapi.yaml`](contracts/kisnet/openapi.yaml) is the sole
  repository authority for external HTTP and serialized Nexacro wire facts.
- [`contracts/kisnet/cases.json`](contracts/kisnet/cases.json) and its fictional
  XML fixtures are independently authored behavioral evidence. They do not
  define endpoints, transport bounds, or parser policy.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) owns component boundaries, dependency
  direction, and error ownership.
- [`docs/provider-qualification.md`](docs/provider-qualification.md) owns the
  distinction between protocol conformance, observed availability, and
  production suitability.

## Surface ownership transition

The current checkout exposes the Rust implementation as a public Rust SDK and
through a Node-API-backed Node SDK. The Node package still owns the temporary
JavaScript CLI; the approved target moves the `ytm` executable to a separate
Rust/Clap crate and removes that npm executable. The remaining migration must
preserve the product behavior in this contract; its component boundary and
completion criteria live in
[`ARCHITECTURE.md`](ARCHITECTURE.md) and
[`plans/rust-sdk-node-sdk-rust-cli.md`](plans/rust-sdk-node-sdk-rust-cli.md).

## Product behavior

- `baseDate` accepts `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYYMMDD` and normalizes to
  `YYYY-MM-DD`.
- `kind` accepts a source code, a numeric-looking value, or a Korean label.
  Surrounding whitespace is ignored; label comparison also ignores internal
  whitespace.
- Lookup is exact-date unless the caller explicitly requests
  `previous-available` resolution.
- Previous-available resolution tries the requested date first, then earlier
  calendar dates in order, within a caller-bounded window of 1 through 31 prior
  days. The default window is 10.
- Only confirmed empty source data advances fallback. Transport, protocol,
  source-format, validation, and kind-resolution failures stop immediately.
- A successful matrix contains at least one row and records requested,
  attempted, and resolved dates.
- Empty or exact `-` yield cells become `null`. Numeric yield cells may contain
  source-observed leading ASCII-space fixed-width padding; validation and
  parsing use the unpadded numeric view while `yieldText` and `raw` preserve the
  exact original cell. Trailing, internal, or non-ASCII whitespace remains a
  source-format error, as do other invalid numeric cells and missing required
  columns.
- Source kinds, pricing groups, and unknown row columns remain open for source
  compatibility. Output tenor labels and order remain deterministic.

## Supported-kind policy and kind 80

The product owns a canonical inspected kind catalog; live discovery augments it
but cannot remove or silently redefine a supported kind.

- The canonical catalog is ordered by source code and includes codes `10`
  through `70` plus `{ "code": "80", "name": "회사채(사모)" }`.
- Code `80` remains distinct from code `70` (`회사채(무보증)`).
- Merge canonical and live kinds by code. Canonical entries retain canonical
  order; genuinely live-only codes follow in first-seen source order.
- An identical live entry coalesces. A duplicate live code with conflicting
  labels, or a live label that conflicts with a canonical code, is a
  `source_format_error`.
- Offline and dated `kinds` include code `80` even when live initialization
  omits it.
- Matrix lookup by `80`, numeric `80`, exact label, or whitespace-normalized
  label sends kind 80 on every attempt. Date fallback never changes the kind.
- No alias, code-70 fallback, synthetic spread, or synthesized yield is valid.
  Empty code-80 rows use the ordinary unavailable-data behavior.

This is the approved divergence from the archived `0.2.0` implementation and
the completed acceptance boundary for GitHub issue #7. Every future Rust SDK,
Node SDK, and CLI surface must preserve it.

## Current Node surfaces

The CLI is:

```sh
ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv] [--pretty]
ytm kinds [--base-date <기준일>] [--format json|csv|tsv] [--pretty]
```

JSON is the default. A successful JSON command prints exactly one
`{ "ok": true, "operation", "result" }` object. A failure prints exactly one
structured JSON object and exits nonzero; data needed to consume the result is
never available only on stderr.

`@sjunepark/ytm/toolset` exports `createKisnetYtmToolset()` with `help`,
`listOperations`, `getOperation`, `getCommandHelp`, `validateInput`, `execute`,
and `serializeError`. Discovery, help, and validation remain network-free.
Execution accepts cancellation through `AbortSignal`. The rewrite intentionally
removes the legacy public `context.fetch` injection seam because allowing a
JavaScript transport would violate the single Rust conformer boundary.

A matrix result uses camelCase fields: `baseDate`, `requestedBaseDate`,
`dateResolution`, `kind`, `tenors`, `rows`, and `source`. Rows expose
`pricingGroupCode`, `pricingGroupName`, numeric-or-null `yields`, source
`yieldText`, and open raw columns.

Source failures use `source_data_unavailable`, `source_transport_error`,
`source_protocol_error`, and `source_format_error`. Protocol failures preserve
the source status and message. Validation failures preserve specific codes and
machine-readable recovery metadata.

## Current runtime boundary

The repository now contains a public Rust SDK plus the current Node SDK and
temporary JavaScript CLI. Historical Python releases and component tags remain
immutable registry and Git history, but no Python source, API, package, CI,
live smoke, or release path is part of this repository state. The standalone
Rust CLI does not reintroduce Python or a second KIS-NET implementation.
