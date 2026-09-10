# Multi-date YTM history and Excel export

Status: complete — delivered to dev in PR #35 (9367a86).

## Outcome

Users can retrieve all YTM categories and pricing-group rows for selected
dates or an inclusive daily date range through the Rust, Node, and Python SDKs
and the standalone CLI. The CLI can save the combined history as a filterable
Excel workbook. Users do not have to spell rating or pricing-group selectors
correctly; source labels and codes remain available for downstream filtering.

The primary workload is daily history over months or a few years. Exact-date
retrieval keeps available observations and explicitly accounts for unavailable
date/category combinations. Previous-available lookup is opt-in and always
exposes the actual observation date.

## Current state

The delivered feature implements history across Rust, Node, Python sync/async and
CLI, with three-sheet Excel export. Independent history/regression scenarios,
installed Python consumers, Rust consumers, strict Node type checks, actual CLI
interrupt/file-safety checks and Excel filter/freeze QA passed. Bounded review
findings were fixed; the full repository gate passed.

[SPEC](../SPEC.md) owns the implemented behavior and
[architecture](../ARCHITECTURE.md) owns retrieval structure.
[Capacity evidence](../docs/history-capacity.md) records monthly, three-year,
maximum-lookback and 2,000-date workloads, including full CLI JSON allocation.
[PR #35](https://github.com/cpaikr/ytm/pull/35) merged to dev on 2026-09-07
as 9367a86, preserving all three commits. All review findings were handled;
[latest-head CI](https://github.com/cpaikr/ytm/actions/runs/34105713662) passed
the repository gate and full native/installed-consumer compatibility matrix.
No production provider enablement or release publication was performed by this
delivery.

## Retained decisions and evidence

The original delivery added date-list and inclusive-range history; the later
[count-selection delivery](count-based-ytm-history.md) extended selection.
The [public history contract](../SPEC.md#multi-date-history) now owns all selection,
availability, fallback, ordering, resource bounds, and export rules. Do not use
this completed plan as a second API specification.

The accepted design keeps source labels and category identities, represents
unavailability explicitly, and fails the whole operation on operational errors.
Fallback resolves each requested date/category independently; it does not promise
a single shared market-date snapshot. Core orchestration owns retrieval and
invocation-local reuse; the CLI owns workbook rendering and safe publication.
These decisions avoid adapter-specific loops and fabricated missing-data success.

Acceptance covered invalid input without requests; canonical omissions and dated
live additions; partial and all-unavailable results; bounded fallback and request
reuse; fatal failures and cancellation; SDK parity; CLI output and file safety;
and independent ZIP/XML inspection plus Excel application QA. The
[capacity record](../docs/history-capacity.md) owns measured requests, allocation,
output sizes, and limit-boundary results. These are synthetic measurements, not
provider throughput or historical-coverage guarantees.

The [goal record](../goals/multi-date-ytm-history.md) preserves the original
contract and terminal delivery evidence. Retries and configurable pacing were
outside that delivery and were subsequently implemented by the
[recovery](resilient-history-retrieval.md) and
[bulk controls](bulk-retrieval-controls.md) work.

## Next action

None — this delivery is complete. The
[provider decision](../tasks/resolve-production-provider-enablement.md) remains
separate; ongoing publication belongs to [release operations](../docs/release.md).
