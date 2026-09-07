# Add Excel export to the CLI

Status: implemented locally — PR review and native CI pending.

## Outcome

Users can save usable Excel `.xlsx` workbooks from standalone `ytm matrix`
and `ytm kinds`, preserving typed values, source order, Korean labels, and
source/date provenance. Explicit, safe file publication preserves an existing
destination on failure. Existing text output and SDK behavior remain compatible.

The [public Excel contract](../SPEC.md#cli-excel-export) owns CLI options,
receipts, errors, cell types, metadata, layout, and publication guarantees.
[Architecture](../ARCHITECTURE.md#runtime-flows) owns presentation and
filesystem boundaries. This plan owns acceptance evidence and delivery status
under the [goal contract](../goals/cli-excel-export.md).

## Current state

The connected implementation is present in the CLI. Shared typed tables serve
CSV/TSV and XLSX; private workbook rendering and publication use CLI-only
`rust_xlsxwriter = 0.99.0` and `tempfile = 3.27.0`. No core or SDK API change is
needed. Synthetic fixture coverage and local repository validation pass.

A bounded review found an ordering bug in the judge's unused-golden check;
it was moved after all scenarios and the complete validation passed afterward.
Documentation and generated dependency notices describe the implementation.
Native packaged-binary CI and PR feedback remain required before completion.

## Acceptance evidence

| Criterion | Evidence and remaining verification |
| --- | --- |
| Matrix and kinds exports | Real CLI judge scenarios inspect exactly the data and Metadata sheets, receipts, headers, order, values, styles, and dated/undated source metadata. |
| Value fidelity | Independent ZIP/XML inspection checks positive/negative/zero numbers, blanks, padded decimals, leading-zero text codes, literal formula-like names and URLs, booleans, and ISO dates including year 0000. No formulas or external links. |
| Fallback and provenance | Separate JSON fixture results are compared against both workbook sheets; request captures assert attempted-date ordering and no extra fetches. |
| Invocation and help | Parser and executable tests cover invalid paths/options, duplicate flags, inline syntax, repeated pretty, and help without execution inputs; captures verify no requests. |
| Publication safety | Tests cover preflight rejection, directory/symlink destinations, missing parents, relative/absolute/Korean paths, existing-file protection, successful replacement, post-preflight destination races, and competing no-clobber writers. |
| Partial failures and bounds | Renderer tests reject oversized strings and invalid dimensions; injected staging writes and publish failures preserve old bytes and clean staging. Executable stdout failure preserves an already published workbook. |
| Compatibility | Full judge passes with existing JSON/CSV/TSV and SDK output preserved; existing golden changes are limited to intentional help/format descriptions. |
| Repository gate | `PYO3_PYTHON=/opt/homebrew/bin/python3.13 bun run validate` passed on macOS ARM64, including formatting, Clippy, workspace/SDK checks, dependency/security policy, notices, and full judge. The host's default Python 3.9 is below the repository's supported range. |
| Excel application QA | Synthetic fallback matrix opened in Microsoft Excel on macOS without a repair prompt; Korean text, blanks, `0.000` numeric display, frozen identity columns through the last tenor, populated filters, and provenance were visually checked. |
| Standalone platforms | Exact candidate consumer now tests undated kinds export, ZIP signature/receipt, existing-file rejection, overwrite, Windows exclusive file locking, and non-root Unix permission denial. Linux x64/ARM64, macOS ARM64, and Windows x64 CI results are pending. |

Full workbook semantics belong to the judge's independent Python standard-library
inspector; exact-binary consumers use a small network-free export smoke. Neither
adds a product runtime dependency. Golden updates use the complete unfiltered
judge and compare semantic results, not nondeterministic archive bytes.

## Completion checklist

- [x] Arguments, executable output selection, structured receipts and errors.
- [x] Shared typed tables, both workbook layouts, and explicit provenance.
- [x] Same-directory staging, no-clobber/replace publication, and failure tests.
- [x] Real CLI judge and exact-candidate consumer coverage.
- [x] Local required validation, bounded review, and affected documentation.
- [ ] Native CI and complete PR feedback handling.
- [ ] Merge the connected PR to dev and persist terminal planning metadata.

## Next action

Open the connected PR to dev with the initial CodeRabbit review, complete
native CI and feedback handling, then merge with commits preserved. Record
terminal goal and project state directly on dev after the merge.

## Scope boundaries

Release publication and production provider enablement remain excluded.
Validation uses synthetic fixtures and does not alter live-data retention
policy. No charts, formulas, macros, templates, automatic Excel opening,
workbook append/update, or multiple-date/kind aggregation are included.
Existing JSON owns raw columns and source `yieldText`. Publication promises
normal failure safety, not power-loss durability or recovery from uncatchable
termination; no background cleanup subsystem is introduced.
