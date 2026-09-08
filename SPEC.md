# KIS-NET YTM Matrix Product Contract

## Capability

`ytm` retrieves KIS-NET YTM Matrix rows by `baseDate` (`기준일`) and
`kind` (`종류`), or all categories across multiple dates with `history`. It
reproduces the source protocol directly and does not drive a browser.

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

## Multi-date history

`history` accepts exactly one selection: a nonempty `baseDates` list or both
`startDate` and `endDate` for an inclusive calendar range. Dates use the matrix
formats, normalize, sort ascending, and deduplicate. The bound is 2,000 raw list
entries before deduplication or 2,000 inclusive range days. Reversed, incomplete,
mixed, oversized, or unknown inputs fail before source I/O. History accepts no
kind or pricing-group filter: each requested date targets the canonical catalog
plus its dated live-only kinds, preserving canonical then source order, and
returns every source pricing-group row and tenor.

Exact-date lookup is the default. Explicit `previous-available` uses the same
1–31 prior-calendar-day bound and default 10 as matrix. Each requested-date/kind
pair resolves independently without changing kind code. Confirmed empty dated
discovery is recorded and uses canonical targets; it can advance fallback.
Fallback discovery does not add new targets to the requested date. Confirmed
empty matrices also advance fallback. Operational errors, conflicting catalogs,
invalid source cells, and cancellation abort the whole call without a partial
success. Fatal source errors retain requested date, kind when known, and
attempt history under operation `history`.

The result contains `requestedDates`, dated `discovery` availability, ordered
`entries`, `availableCount`, `unavailableCount`, `dataRowCount`, `mode`, and
`lookbackDays`. Counts of availability refer to date/kind pairs; data rows count
pricing groups. An entry tagged `availability: "available"` contains a complete
`matrix` with requested, attempted, and actual dates and source provenance.
An `unavailable` entry carries `requestedBaseDate`, `kind`, `attemptedDates`,
`mode`, `lookbackDays`, `reason`, and final `stage` (`discovery` or `matrix`).
Unavailable pairs, including an entirely unavailable selection, are a successful
result and CLI exit 0. Requested dates remain distinct even when they resolve
to the same observation; output order is date, catalog kind, then source row.

CLI CSV/TSV use the matrix identity and tenor columns followed by `availability`
and `reason`. An unavailable pair produces one row with empty actual-date,
fallback, pricing-group, and yield cells. JSON retains the complete result.
The CLI handles Ctrl-C through cancellation; history exports check cancellation
before publication. Interactive stderr may show throttled discovery and
retrieval counts, including fallback; redirected stderr remains quiet and all
machine-readable results remain on stdout.

The [capacity evidence](docs/history-capacity.md) records measured synthetic
workloads and memory limits. The selection bound is a resource guard, not provider
approval for sustained collection. Production enablement and release publication remain separate
boundaries under [provider qualification](docs/provider-qualification.md) and
[release policy](docs/release.md).

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
ytm history (--base-date <date>... | --start-date <date> --end-date <date>) [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]
ytm matrix --base-date <기준일> --kind <종류> [--fallback previous-available] [--lookback-days <days>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]
ytm kinds [--base-date <기준일>] [--format json|csv|tsv|xlsx] [--output <file.xlsx>] [--overwrite] [--pretty]
ytm upgrade [--check]
```

For `history`, `matrix`, and `kinds`, `--help` or `-h` prints command help without network
I/O while validating supplied options. Value options accept `--option value`
and `--option=value`; repeated `--pretty` is allowed.

`ytm --version` is network-free and prints exactly `ytm <product-version>`
followed by one newline on stdout. It has no update-check or other side effect.
History, matrix, and kinds commands never inspect a receipt, check for updates, wait for
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

All three data commands accept `--format xlsx --output <file.xlsx>`. The path must
have a nonempty filename ending in `.xlsx` (case-insensitive); relative and
absolute Unicode paths, spaces, and Korean filenames are supported. The CLI
does not infer a format, append an extension, create parent directories, or
write binary stdout. `--output -` is invalid. `--output` and `--overwrite` are
XLSX-only; duplicate value options (except history’s repeated `--base-date`)
and repeated `--overwrite` are invalid.
Invalid combinations and path syntax fail before filesystem or network I/O
with the existing structured invocation error and exit 2. Command help
validates supplied options without requiring execution inputs or a destination.

The parent directory must exist. Preflight rejects an existing destination
without `--overwrite`, and rejects directories, symlinks, and special files
with either policy, before source requests. A successful export publishes a
complete workbook and then returns exit 0 and one JSON receipt (interactive
history progress may appear on stderr):

```json
{"ok":true,"operation":"matrix","result":{"format":"xlsx","path":"yields.xlsx","rowCount":1}}
```

`path` echoes the supplied path; `rowCount` excludes headers and metadata.
`--pretty` affects only the success receipt. Failures remain compact JSON.
If stdout fails after publication, the command exits 1 and retains the saved
workbook.

Matrix and kinds workbooks have exactly two visible worksheets: `Matrix` or `Kinds`, followed
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

For matrix and kinds, `Metadata` has `field` and `value` columns, a frozen header, wrapped values,
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

History workbooks have exactly three visible worksheets: `History`,
`Availability`, and `Metadata`. `History` uses the matrix columns and formatting
above and contains only available pricing-group rows. `Availability` has one row
per date/kind pair with `requestedBaseDate`, `kindCode`, `kindName`,
`availability`, `baseDate`, `usedFallback`, `rowCount`, `reason`, and
`discoveryAvailable`. `Metadata` records normalized requested dates, discovery
outcomes, mode, lookback, aggregate counts, each pair's attempted dates, and
available observations' source provenance. History metadata values are literal
text. A wholly unavailable history still publishes headers, availability, and
metadata. Its receipt adds `availableCount`, `unavailableCount`, and
`dataRowCount`; `rowCount` counts only `History` data rows.

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

Export runtime failures exit 1 with the existing error envelope; only
interactive history progress may have been written to stderr. CLI-owned codes are `output_exists`, `output_write_error`,
`export_error`, and `request_cancelled` (export cancelled before publication);
each identifies the operation and `output`, with a reason and
recovery information. Worksheet limits and oversized cells fail explicitly
without truncation. Source failures retain their existing codes and leave the
workbook untouched. Rendering and publication failures never trigger source
fallback or another request. SDK APIs and dependencies are unaffected.

### SDK results and errors

`@sjunepark/ytm` is the Rust-backed Node SDK. Its root export provides
`YtmClient` with typed `history()`, `matrix()`, and `kinds()` methods. The operation-specific
`validateHistoryInput()`, `validateMatrixInput()`, and `validateKindsInput()` helpers return either
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
wheel coverage. Exact development consumers validate that packaging boundary.
GitHub release publication distributes only the standalone CLI; Node and Python
SDKs remain available from source and local packages. Historical Python releases
and component tags remain immutable registry and Git history and do not expose
the new Python API.
