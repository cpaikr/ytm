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
through Node and Python SDKs, and through a standalone Rust/Clap `ytm`
executable. The Node package has no `bin` entry or JavaScript CLI. These
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
Node SDK, Python SDK, and CLI surface must preserve it.

## Public SDK and CLI surfaces

The standalone Rust CLI is:

```sh
ytm --version
ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]
ytm kinds [--base-date <기준일>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]
ytm upgrade [--check]
```

For `matrix` and `kinds`, `--help` or `-h` prints command help without network
I/O while validating supplied options. Value options accept `--option value`
and `--option=value`; repeated `--pretty` is allowed.

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

JSON is the default. A successful JSON data command prints exactly one
`{ "ok": true, "operation", "result" }` object; CSV and TSV print a header and data rows. Execution and invalid-invocation
failures print exactly one structured JSON object and exit nonzero; data needed
to consume the result is never available only on stderr. The help lookup
`ytm help <unknown>` is the sole plain-text failure: it reports the unknown help
topic and exits with status 2.

### CLI Excel export

Both data commands accept `--format xlsx --output <file.xlsx>`. The path must
have a nonempty filename ending in `.xlsx` (case-insensitive); relative and
absolute Unicode paths, spaces, and Korean filenames are supported. The CLI
does not infer a format, append an extension, create parent directories, or
write binary stdout. `--output -` is invalid. `--output` and `--overwrite` are
XLSX-only; duplicate value options and repeated `--overwrite` are invalid.
Invalid combinations and path syntax fail before filesystem or network I/O
with the existing structured invocation error and exit 2. Command help
validates supplied options without requiring execution inputs or a destination.

The parent directory must exist. Preflight rejects an existing destination
without `--overwrite`, and rejects directories, symlinks, and special files
with either policy, before source requests. A successful export publishes a
complete workbook and then returns exit 0, empty stderr, and one JSON receipt:

```json
{"ok":true,"operation":"matrix","result":{"format":"xlsx","path":"yields.xlsx","rowCount":1}}
```

`path` echoes the supplied path; `rowCount` excludes headers and metadata.
`--pretty` affects only the success receipt. Failures remain compact JSON.
If stdout fails after publication, the command exits 1 and retains the saved
workbook.

Workbooks have exactly two visible worksheets: `Matrix` or `Kinds`, followed
by `Metadata`. `Matrix` has these columns in order, followed by `result.tenors`
in source order:

```text
requestedBaseDate, baseDate, usedFallback, kindCode, kindName,
pricingGroupCode, pricingGroupName
```

Rows preserve source order. `Kinds` has `code` and `name`. Yields are numeric
cells with no rounding or scaling and display format `0.000`; missing yields
are blank. Codes preserve leading zeros as text. Dates are ISO text, including
years outside Excel serial-date support. Fallback flags are boolean. Names,
headers, dates, URLs, and codes are literal Unicode text, with no formula or
hyperlink inference or CSV apostrophe prefix. Data sheets have bold contrasting
headers, autofilters, wrapped names, and readable column widths. `Matrix`
freezes the header and seven identity columns; `Kinds` freezes the header.
Empty tables retain headers and metadata with `rowCount: 0` without changing
the core's unavailable-data semantics.

`Metadata` has `field` and `value` columns, a frozen header, wrapped values,
and this explicit provenance mapping:

- Common: `operation`, `baseDate`, `source.pageUrl`, and available
  `source.endpoint`, `source.method`, `source.inspectedWorkflow`, `source.note`.
- Matrix: `requestedBaseDate`, `kind.code`, `kind.name`,
  `dateResolution.mode`, `dateResolution.resolvedBaseDate`,
  `dateResolution.usedFallback`, `dateResolution.lookbackDays`, and ordered
  `dateResolution.attemptedDates[0]`, `[1]`, etc.
- When a source request exists: `source.request.format`,
  `source.request.inDatasets`, `source.request.outDatasets`,
  `source.request.parameters.calBaseDt`, and
  `source.request.parameters.cboYtmSort`.

Absent optional source fields are omitted; undated kinds has a blank
`baseDate`. Metadata booleans and lookback counts retain native types; all
other values are literal text. Raw XML, raw columns, and source `yieldText`
remain available through existing interfaces rather than additional sheets.

The CLI renders a complete buffer, writes and syncs a private staging file
beside the destination, closes its handle, and publishes it. Without
`--overwrite`, publication cannot replace an entry created after preflight.
With overwrite, publication replaces the directory entry without first
deleting it or writing through a raced destination symlink. Concurrent
explicit overwrites accept the last successful publication. Normal failures
preserve existing bytes and clean owned staging files; cleanup errors do not
mask the primary failure. The final path never exposes a partial workbook.
Power-loss durability and recovery from uncatchable termination are not
promised; termination can leave private staging files.

Export runtime failures exit 1 with empty stderr and the existing error
envelope. CLI-owned codes are `output_exists`, `output_write_error`, and
`export_error`; each identifies the operation and `output`, with a reason and
recovery information. Worksheet limits and oversized cells fail explicitly
without truncation. Source failures retain their existing codes and leave the
workbook untouched. Rendering and publication failures never trigger source
fallback or another request. SDK APIs and dependencies are unaffected.

### SDK results and errors

`@sjunepark/ytm` is the Rust-backed Node SDK. Its root export provides
`YtmClient` with typed `matrix()` and `kinds()` methods. The operation-specific
`validateMatrixInput()` and `validateKindsInput()` helpers return either
`{ ok: true, input }` or `{ ok: false, error }` without performing network I/O.
`YtmError` and `serializeYtmError()` preserve stable `name`, `message`, project
error fields, and a tagged `recoveryAction` object. Client methods accept
cancellation through `AbortSignal`. The rewrite intentionally
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

The repository contains a public Rust SDK, Rust-backed Node and Python SDKs,
and a standalone Rust CLI over the same core. The
[Python API contract](packages/python/SPEC.md) defines its typed sync/async
clients, values, cancellation, lifecycle, and errors. The
[Python matrix](python-targets.json) owns the conventional CPython and native
wheel coverage. Exact consumers and the disabled unified release/PyPI
projection validate that distribution boundary. Historical Python releases and component tags remain immutable
registry and Git history and do not expose the new Python API.
