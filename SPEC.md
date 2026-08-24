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

## Surface ownership

The current checkout exposes the Rust implementation as a public Rust SDK,
through a Node-API-backed Node SDK, and through a standalone Rust/Clap `ytm`
executable. The Node package has no `bin` entry or JavaScript CLI. All three
surfaces preserve the product behavior in this contract; their component
boundaries live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

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

## Public SDK and CLI surfaces

The standalone Rust CLI is:

```sh
ytm --version
ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv] [--pretty]
ytm kinds [--base-date <기준일>] [--format json|csv|tsv] [--pretty]
ytm upgrade [--check]
```

`ytm --version` is network-free and prints exactly `ytm <product-version>`
followed by one newline on stdout. It has no update-check or other side effect.
Matrix and kinds commands never inspect a receipt, check for updates, wait for
release infrastructure, or change their stdout or exit status because a newer
release exists.

An official installer writes an adjacent `ytm.receipt` on Unix or
`ytm.exe.receipt` on Windows. The receipt is canonical LF-terminated UTF-8 in
this exact order:

```text
schema=1
version=<stable semantic version>
target=<cli-targets.json key>
executable=<ytm or ytm.exe>
release_source=https://github.com/cpaikr/ytm/releases/download/v<version>
installed_sha256=<lowercase executable SHA-256>
```

Receipt fields are closed: missing, duplicated, unknown, reordered, empty, or
noncanonical values invalidate managed upgrade. A managed executable must be a
directly installed regular file with the manifest-derived target and name; a
renamed, symlinked, locally built, receipt-less, or digest-modified executable
is unmanaged.

`ytm upgrade --check` verifies the receipt and installed executable, then reads
the latest public, stable GitHub Release. It returns one structured JSON object
describing `upToDate`, `updateAvailable`, or `aheadOfLatest`; it does not
download an installer or change local files. `ytm upgrade` verifies the same
local identity, release tag and required assets, the sorted `SHA256SUMS`, the
platform installer digest, and the installer-pinned archive digest. It then
delegates replacement to that verified generated installer. Same-version and
downgrade results do not replace the install.

Unix replacement stages both files beside the installation, preserves the
verified prior pair under fixed adjacent `.previous` names, publishes the
executable followed by the receipt as the commit marker, verifies the new pair,
and removes recovery files. Ordinary failures and catchable termination restore
the prior pair. Windows stages the pair and launches an out-of-process
PowerShell helper, because the running executable cannot replace its mapped
image; the command returns `scheduled`, the exact `statusPath`, and
`restartRequired: true`. The installer replaces any prior result with a
no-BOM UTF-8 `scheduled` status before launch. Status changes commit through a
same-directory atomic replacement. The helper waits at most 120 seconds for
that exact parent process identity to exit, failing closed if identity cannot
be confirmed, then records its structured result in
`.ytm.exe.upgrade-status.json`. An exclusively created
`.ytm.exe.upgrade-in-progress` marker prevents concurrent helpers. An
uncatchable interruption or uncommitted terminal status leaves that marker;
failed terminal-status publication also retains the helper source and records
a sanitized `status_error` in the marker. Replacement interruption may also
leave fixed `.previous` evidence.
Subsequent checks fail closed and report the exact
executable, receipt, and recovery paths instead of guessing or deleting
evidence.

JSON is the default. A successful data command prints exactly one
`{ "ok": true, "operation", "result" }` object. Execution and invalid-invocation
failures print exactly one structured JSON object and exit nonzero; data needed
to consume the result is never available only on stderr. The help lookup
`ytm help <unknown>` is the sole plain-text failure: it reports the unknown help
topic and exits with status 2.

`@sjunepark/ytm/toolset` is the Rust-backed Node SDK. It exports
`createKisnetYtmToolset()` with `help`,
`listOperations`, `getOperation`, `getCommandHelp`, `validateInput`, `execute`,
and `serializeError`. `help()` and command help return cloned structured
objects; examples are direct operation inputs. Validation returns either
`{ ok: true, input }` or `{ ok: false, error }`. Serialized errors retain stable
`name`, `message`, project error fields, and a tagged `recoveryAction` object.
Discovery, help, and validation remain network-free.
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

## Runtime boundary

The repository contains a public Rust SDK, a Rust-backed Node SDK, and a
standalone Rust CLI over the same core. Historical Python releases and
component tags remain immutable registry and Git history, but no Python source,
API, package, CI, live smoke, or release path is part of this repository state.
The Rust CLI does not reintroduce Python or a second KIS-NET implementation.
