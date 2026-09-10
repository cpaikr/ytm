# Resilient historical retrieval

## Outcome

Implement [issue #45](https://github.com/cpaikr/ytm/issues/45): a transient
failure of a KIS-NET lookup can recover within bounded attempts and one overall
retrieval deadline, without changing requested dates, category identities,
selected observations, yields, source identity, or all-or-error publication.
Rust, CLI, Node, and Python use the same core policy.

Implementation through offline acceptance was delivered under the completed
[goal contract](../goals/resilient-history-retrieval-offline.md). Full live
acceptance passed in the single authorized assessment. Subsequent release
publication is recorded separately in [GitHub Releases](https://github.com/cpaikr/ytm/releases).

## Current state

Offline implementation is complete and merged through
[PR #46](https://github.com/cpaikr/ytm/pull/46), merge `f6056a4`.
Implementation `11d534f` and validation follow-up `51bfca4` are preserved.

- Real-HTTP recovery replays only the failed lookup and matches the baseline
  result and request sequence. Core and public CLI/Node/Python checks cover
  deadlines, cancellation, source errors, client reuse and protected exports.
- Every local gate stage and [required platform CI](https://github.com/cpaikr/ytm/actions/runs/34345673007)
  passed. Windows acceptance passed after correcting a platform-specific
  overflow assumption in the test harness. Independent reviews, Codex review,
  CodeRabbit feedback resolution and documentation reconciliation are complete.
- The single authorized full live run passed: 180 selected observations,
  261 scanned dates, exit 0, 60.783 seconds on macOS ARM64. The
  [sanitized evidence](../docs/history-retrieval-live-acceptance.md) records the
  candidate and every acceptance check. Independent evidence review passed;
  [issue #45](https://github.com/cpaikr/ytm/issues/45#issuecomment-5610130717) is closed as completed.
  No repeat run or release publication occurred within that assessment.

## Next action

None for retrieval acceptance — implementation and full live acceptance are
complete. Subsequent integration and release work do not expand the one-off
live-run authority. [Release operations](../docs/release.md) own publication.

## Implemented policy and retained decisions

[SPEC](../SPEC.md#bounded-retrieval-recovery) owns replay eligibility, attempts,
waits, the shared deadline, errors, and compatibility.
[Architecture](../ARCHITECTURE.md) owns the transport and service boundary.
The later [bulk controls delivery](bulk-retrieval-controls.md) added configurable
retries, optional pacing, and statistics while preserving default selection and
recovery behavior.

The default retry schedule and retrieval deadline are engineering choices, not
provider quotas. The successful live assessment validates one identified workload
on one host; it does not establish general throughput, Windows incident-host
acceptance, production rights, or permission for repeated bulk runs.

Typed transport failures distinguish recoverable interrupted bodies from corrupt
or unclassified failures. Recovery replays only the failed lookup, retaining the
completed prefix and source identity. Operational failures remain terminal after
the configured budget and cannot become missing data or partial exports.

## Acceptance evidence

Deterministic real-HTTP regressions reproduced a late-category failure before the
fix, then verified identical requests and results after recovery. Offline coverage
includes initialization/body interruption, eligible and terminal failures,
backoff and Retry-After bounds, the shared deadline, cancellation and client reuse,
structured errors, CLI destination protection, and synthetic count/scan limits.
Test routing remains excluded from release builds.

The [offline goal](../goals/resilient-history-retrieval-offline.md) preserves its
completed delivery contract and validation evidence. Its then-pending live stage
was completed by the [assessment goal](../goals/retrieval-live-acceptance.md).
The [live evidence record](../docs/history-retrieval-live-acceptance.md) is the
canonical home for candidate identity, authorization, sanitized measurements,
and acceptance checks. No live source payload or yield rows were retained.

Production qualification remains with the
[provider enablement task](../tasks/resolve-production-provider-enablement.md).
