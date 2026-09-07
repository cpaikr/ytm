# Add Excel export to the CLI

Status: planned — implementation has not started.

## Outcome

Users can save a usable Excel `.xlsx` workbook from `ytm matrix` and
`ytm kinds` through the standalone CLI. Workbooks preserve typed values,
source ordering, Korean labels, and date/source provenance. File publication
is explicit and failures leave an existing destination intact.

This document owns the proposed implementation target and acceptance criteria.
[SPEC.md](../SPEC.md) continues to describe implemented public behavior until
the feature lands. Creating this plan authorizes planning only.

## Current state

- [CLI parsing and rendering](../crates/ytm-cli/src/lib.rs) support JSON, CSV,
  and TSV. `ProcessOutput` holds textual stdout/stderr; there is no data-export
  file destination. CSV/TSV rendering already distinguishes text, numbers,
  booleans, and empty cells.
- [Core results](../crates/ytm-core/src/model.rs) provide ordered tenors,
  numeric-or-null yields, source strings, kind/pricing-group identifiers,
  requested/resolved dates, fallback attempts, and source metadata. No new
  source request or core data model is needed.
- The [architecture](../ARCHITECTURE.md) assigns presentation and filesystem
  behavior to the CLI. Rust, Node, and Python SDKs are sibling consumers and
  do not need Excel dependencies or API changes.
- Investigation baseline on 2026-09-07: `cargo test --locked -p ytm-cli`
  passed all 17 tests. XLSX generation, dependency resolution, and workbook
  compatibility have not been tested.
- The existing [judge](../judge/README.md) executes the real CLI with a
  compile-time-only fixture transport and golden stdout/stderr results.
- [Provider qualification](../docs/provider-qualification.md) remains separate.
  Implementation and retained validation workbooks use synthetic fixtures;
  this plan does not change production enablement or live-data retention policy.

## Next action

When implementation is requested, re-enter `$progress`, reconcile repository
state, move this plan from the queue to `Current`, and implement the argument
contract and typed output selection described below. Do not publish a release
or start the separate provider-enablement task as part of this plan.

## Target CLI contract

```sh
ytm matrix --base-date 2026-06-08 --kind 국채 \
  --format xlsx --output yields.xlsx

ytm matrix --base-date 2026-06-07 --kind 국채 \
  --fallback previous-available --lookback-days 2 \
  --format xlsx --output yields.xlsx --overwrite

ytm kinds --format xlsx --output kinds.xlsx
```

| Option or condition | Target behavior |
| --- | --- |
| `--format xlsx` | Available on both data commands; requires `--output` during execution. |
| `--output <path>` | XLSX-only destination; accept relative/absolute paths, spaces, and Korean filenames. Require a nonempty filename ending in `.xlsx`, case-insensitively. Do not infer the format or append an extension. |
| `--overwrite` | XLSX-only flag; permits replacing the destination. With no existing file, still creates it. Without it, publication must never replace an existing entry. |
| `--pretty` | Retain current behavior for existing formats; for XLSX, pretty-print only the JSON success receipt. Failures retain the existing compact JSON convention. |
| Invalid combinations | `--output` or `--overwrite` with JSON/CSV/TSV, a missing XLSX output path, or a malformed path value are structured invocation failures, exit 2. Reject before network or filesystem mutation. |
| Command help | No network or filesystem access. Validate supplied option values and incompatible combinations, but allow `ytm matrix --help --format xlsx` without required execution inputs or a destination. |
| Option syntax | Support both `--option value` and `--option=value`. Preserve duplicate-value rejection, repeated `--pretty`, and existing help-token behavior; reject repeated `--overwrite`. |
| Binary stdout | Not supported. `--output -` is invalid. stdout remains a textual machine interface. |
| Parent directory | Must already exist. Do not create directory trees or choose a default destination. |

On success, emit exactly one JSON object and exit 0; stderr is empty:

```json
{
  "ok": true,
  "operation": "matrix",
  "result": {
    "format": "xlsx",
    "path": "yields.xlsx",
    "rowCount": 1
  }
}
```

`path` echoes the supplied output path, including its relative form.
`rowCount` counts data rows in `Matrix` or `Kinds`, excluding headers and
metadata. Emit success only after publication completes. A stdout write
failure still exits 1 through the existing executable behavior; the workbook
may already have been saved and must not be removed in response.

Keep the existing structured error envelope. Add CLI-owned runtime error
codes `output_exists`, `output_write_error`, and `export_error`, each with
operation, actionable reason, and recovery information. Destination errors
identify `output`; do not label disk or workbook failures as source failures.
Runtime failures exit 1 with empty stderr. Source failures retain their current
codes and create no workbook. Export failures do not trigger source fallback
or another network request.

## Workbook contract

Workbooks contain exactly two visible worksheets, in the order below. Use
fixed worksheet names so source labels cannot create invalid worksheet names.

### Matrix or Kinds

`Matrix` uses the existing CSV column order:

```text
requestedBaseDate, baseDate, usedFallback, kindCode, kindName,
pricingGroupCode, pricingGroupName, <result.tenors in source order>
```

The current tenors run from `3M` through `50Y`; use `result.tenors` as the
ordering authority rather than introducing a second tenor list. Preserve row
order. `Kinds` contains `code` and `name` in the existing kinds order.

| Value | Excel representation |
| --- | --- |
| Yield | Numeric cell, stored without rounding or scaling, displayed with `0.000`. A source value `2.5` displays as `2.500`; never apply a percentage format. |
| Missing yield | Empty cell, never zero, a dash string, or a formula. |
| Kind/pricing-group code | Explicit text cell, preserving leading zeros. |
| Names and headers | Explicit Unicode text cells, including strings beginning with `=`, `+`, `-`, or `@`. No formula or automatic hyperlink inference. |
| Date | ISO `YYYY-MM-DD` text, consistent with current output and the core's date range, including years outside Excel serial-date support. |
| Fallback flag | Boolean cell. |

Use a bold, contrasting header row; autofilter across the data table; frozen
header and seven identity columns for `Matrix`; frozen header for `Kinds`.
Set widths for ISO dates, identifiers, Korean names, and yields, and wrap long
names. Avoid merged cells, decorative title rows, and whole-sheet borders.
An empty input table, if encountered, produces valid headers and metadata
with `rowCount: 0`; it does not change core unavailable-data semantics.

### Metadata

Use `field` and `value` columns with a frozen header and wrapped values.
Preserve the full available source/date provenance through an explicit stable
mapping rather than serializing an arbitrary result object into one cell:

- Common: `operation`; `baseDate`; `source.pageUrl`; available
  `source.endpoint`, `source.method`, `source.inspectedWorkflow`, and
  `source.note`.
- Matrix: `requestedBaseDate`, `kind.code`, `kind.name`,
  `dateResolution.mode`, `dateResolution.resolvedBaseDate`,
  `dateResolution.usedFallback`, `dateResolution.lookbackDays`, and one row
  per attempt named `dateResolution.attemptedDates[0]`, `[1]`, etc., in order.
- When a source request exists: `source.request.format`,
  `source.request.inDatasets`, `source.request.outDatasets`,
  `source.request.parameters.calBaseDt`, and
  `source.request.parameters.cboYtmSort`.

Omit absent optional source fields; keep an absent kinds `baseDate` blank.
Write booleans and lookback counts with their native cell types; write codes,
dates, URLs, and other source metadata as literal text. Matrix's
`requestedBaseDate` is the same value as the date-resolution requested date;
do not duplicate that field under a second key.

Raw XML, raw-column dumps, and a separate `yieldText` sheet are outside this
version. Existing JSON remains the detailed source-cell representation.
No charts, formulas, macros, templates, append/update of existing workbooks,
multiple-date/kind aggregation, or automatic opening of Excel are included.

## Implementation shape

### CLI output selection

In [lib.rs](../crates/ytm-cli/src/lib.rs), represent validated output as a
small enum with separate text and XLSX variants. The XLSX variant owns its
destination and overwrite policy, so execution cannot receive an XLSX request
without a path. Keep presentation options outside the core input map.

Separate validation of supplied options for help from construction of an
executable output selection. Do not fabricate a placeholder output file to
make help pass. Preserve the existing lossless filesystem path when parsing
supported Unicode arguments; never derive the file destination from an error
message or a normalized display string.

Extract shared typed table projection into a private `table.rs` module:
column names, ordered rows, and the existing empty/text/number/boolean cell
distinction. CSV/TSV apply their current escaping at serialization; XLSX
uses typed writes and does not inherit CSV apostrophe prefixes. Preserve
existing text-output bytes. Use concrete helpers, not an exporter trait,
registry, plugin layer, or generalized document model.

### Workbook rendering and publication

Add a private `xlsx.rs` module that owns workbook construction, formatting,
and destination publication. Build from the shared table projection plus
the typed result metadata. Keep `ProcessOutput` and `main.rs` text-oriented.

Use `rust_xlsxwriter = "=0.99.0"` with standard features only as the initial
dependency candidate. Its [versioned manifest](https://github.com/jmcnamara/rust_xlsxwriter/blob/v0.99.0/Cargo.toml)
declares Rust 1.88 compatibility; the workspace pins Rust 1.92. Its
[typed-cell and workbook APIs](https://docs.rs/rust_xlsxwriter/0.99.0/rust_xlsxwriter/)
support the target without an Excel installation. Confirm the resolved
dependency graph on the pinned toolchain before committing the lockfile.
Do not enable C zlib, Polars, Serde projection, or constant-memory features.

Prefer `tempfile` for secure same-directory staging and no-clobber/replace
publication rather than maintaining platform-specific temporary-file code.
Resolve and exact-pin a compatible version during implementation; verify its
publication guarantees on every target. Both dependencies belong only to
the CLI's production dependency graph, with declarations following workspace
conventions. Test helpers may have separate development dependencies only
when existing facilities cannot verify the behavior simply.

Publication sequence:

1. Validate arguments. Check the destination's parent and reject an existing
   entry without overwrite, or a directory/symlink/special-file destination,
   before fetching. These checks are diagnostics, not the no-clobber guarantee.
2. Execute the existing core operation once, including its existing bounded
   fallback policy. Do not touch the final path on source failure.
3. Render a complete workbook into a byte buffer. Treat worksheet bounds,
   oversized cells, and writer errors as `export_error`; never silently
   truncate values or emit a partial success.
4. Create a private temporary file beside the destination, write the complete
   bytes, flush/sync the staged file, and close handles as required on Windows.
5. Publish using no-clobber semantics by default, including when a competing
   process creates the destination after preflight. With overwrite, replace
   the directory entry with the complete staged file; never delete the old
   file first and never follow a destination symlink to write its target.
6. Clean up owned staging files on ordinary failure. Return a structured error
   with useful I/O context; cleanup failure must not mask the primary error.
   Never report success when publication failed.

The guarantee is that normal failure preserves an old workbook and the final
path never exposes partially written XLSX bytes. Concurrent writers with
overwrite explicitly accept last-successful-publication behavior. Do not
claim power-loss durability or recovery from uncatchable process termination;
such termination may leave a private staging file. There is no background
cleanup or recovery subsystem in this feature.

## Implementation sequence

- [ ] **Argument and output contract:** add flags, executable output enum,
  help validation, JSON receipt, and CLI-local export error mapping. Add
  targeted parser tests for execution/help and invalid combinations.
- [ ] **Shared tables and workbook renderer:** extract table projection while
  preserving CSV/TSV goldens; resolve dependencies; add both workbook layouts
  and explicit metadata mapping. Verify cell values, types, and layout rules.
- [ ] **Safe file publication:** integrate preflight, staging, publication,
  cleanup, and error mapping into the execution path. Verify success and
  failure using temporary directories and fixture results.
- [ ] **Public executable coverage:** extend the judge with real CLI XLSX
  scenarios and an independent workbook inspector. Add a network-free kinds
  export smoke to the exact released-binary consumer tests.
- [ ] **Documentation and completion:** update README examples, SPEC's CLI
  and workbook contract, ARCHITECTURE's rendering flow, judge documentation,
  and dependency notices. Run required validation and bounded review, then
  record evidence here and remove this plan's active roadmap link when done.

These are dependent parts of one feature, not separately authorized releases.
Keep the item current during implementation; do not mark it complete after
only argument parsing or a successful workbook demo.

## Acceptance and validation

### Observable behavior

| Scenario | Required evidence |
| --- | --- |
| Matrix success | Actual CLI exits 0; receipt path/count agree with the saved workbook; exactly `Matrix`, `Metadata` sheets; expected columns, row order, values, and styles. |
| Kinds success | Undated command performs no network calls; exactly `Kinds`, `Metadata`; text codes and Korean names. Dated kinds preserve source metadata from its fixture request. |
| Value fidelity | Numeric positive, negative, and zero yields; blank missing values; padded source decimals normalize identically to JSON; identifiers remain text; formula-like names create no formula cells or external links. |
| Fallback | Requested date, actual date, used flag, attempted dates, and lookback are correct and consistent between sheets; no extra source requests. |
| Workbook limits | Oversized text or worksheet dimensions fail explicitly before publication; prior destination is unchanged. Test the relevant renderer boundary without constructing giant live responses. |
| Invocation/help | Missing/empty/wrong-extension paths, incompatible flags, duplicate values/overwrite, inline syntax, repeated pretty, and help permutations have the defined exit/output behavior; no help filesystem effects or network calls. |
| Filesystem | Relative/absolute paths, spaces/Korean names, nonexistent parent, existing file, directory, symlink, permission denial, and a file locked by Excel on Windows yield the specified result. Prior file bytes survive failed overwrite. |
| Publication race | A destination created after preflight is not overwritten without permission; concurrent no-overwrite attempts cannot both publish. Test the publication helper deterministically. |
| Partial failure | Rendering, staging write, and publish failures leave no partial final file; normal staging cleanup works. Existing main stdout failure semantics remain intact after file publication. |
| Compatibility | Existing JSON/CSV/TSV success bytes, error envelopes, exit statuses, source fallback, help-token handling, and SDK behavior remain covered; only intentional help/format-option goldens change. |
| Standalone targets | Existing Linux x64/ARM64, macOS ARM64, and Windows x64 CI builds remain valid; exact candidate binaries export kinds without Excel, Python, or Node as runtime dependencies. |

Extend `runCli`/`invokeCli` in [judge/run.mjs](../judge/run.mjs) with per-scenario
child working directories and cleanup. For XLSX scenarios, configure the
existing compile-time fixture transport's `YTM_JUDGE_CAPTURE_PATH`, read back
its request captures, and assert expected request counts and ordering,
including zero requests for help and undated kinds. Keep captures outside
the existing golden process-output object; preserve absolute fixture paths
when changing the child working directory. Test preflight rejection with a
fixture that permits no requests.

Use an independent test-only inspector based on Python standard
library `zipfile` and `xml.etree.ElementTree`, invoked with the repository's
configured Python interpreter. Inspect workbook relationships, strings,
cell types/values, number formats, freeze panes, and filter ranges. Handle
shared and inline strings. This adds no product runtime dependency.

Do not reuse [the release archive reader](../scripts/deterministic-archive.mjs)
as an XLSX reader: it intentionally accepts only stored ZIP entries, whereas
XLSX uses compression. Do not weaken that release contract. For exact-binary
consumer smoke, successful undated kinds export, valid ZIP signature, receipt,
and overwrite behavior are sufficient; full workbook inspection belongs to
the judge where Python is already configured.

Golden-test semantic values and process outputs, not raw workbook bytes or
ZIP timestamps. Use relative output paths inside an isolated child working
directory so path receipts stay deterministic. Update goldens only through
the existing complete, unfiltered judge run and inspect every changed entry.

During implementation, run focused CLI tests and the relevant judge scenarios
first. Regenerate license notices with `bun run licenses:generate`, then run
`bun run validate` once the completed feature is integrated. It is the
repository's required gate and includes contracts, licenses, formatting,
Clippy, workspace/SDK tests, security/dependency checks, and the full judge.
Use existing CI/consumer jobs to verify platform-specific publication and
packaged binaries; record unavailable target checks as unverified.

Open a fixture-generated representative matrix workbook in Excel for visual
QA: readable Korean names, all tenors accessible while scrolling, visible
blank cells and fallback metadata, working filters, and no repair prompt.
If Excel is unavailable, record that limitation rather than claiming an
XML inspection proves application compatibility.

After a reviewable implementation slice, run one bounded `$code-review` pass
with a review-only subagent for the shared table/file-publication contracts.
After review, run `$harmonize-docs changes` as required by repository defaults.
Repeat tests only for affected fixes, failures, or unresolved concerns.
Completion requires checked acceptance criteria and truthful validation
evidence; release publication and provider qualification remain separate.
