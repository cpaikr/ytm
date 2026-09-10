# Bulk retrieval controls and visibility

## Outcome

Completed on 2026-09-10: CLI, Rust, Node and Python callers can configure bounded
retries, optionally pace physical requests, and observe metadata-only progress
and final statistics while preserving default request behavior and selected data.

## Current state

- Shared policy, counter semantics and Rust source migration are documented in
  [SPEC](../SPEC.md#bounded-retrieval-recovery); adapter references describe usage.
- [PR #50](https://github.com/cpaikr/ytm/pull/50) merged into
  `codex/bulk-controls-integration` with individual commits preserved.
- Complete local repository validation passed on macOS ARM64 with CPython 3.12.
  Final CI run `34482827880` passed, including repository validation, Linux CLI
  archive and exact packaged Node consumers on Node 22, 24 and 26.
- Synthetic HTTP acceptance completed 180 qualifying dates after 250 scans,
  with 1,704 attempts including 14 retries. Selected values and ordered requests
  matched the unpaced 1,690-attempt baseline.
- Independent implementation and follow-up reviews completed. Codex completed
  clean; all five CodeRabbit findings were fixed, accepted and resolved.
  Regression coverage preserves Python cancellation through native bridge
  failures and final counters through cancellation and CLI export failures.
- Release publication and default-branch promotion remain separate. No new live
  bulk run was performed. PowerShell-only Windows guide execution was outside
  this host's coverage and remains separately tracked.

## Next action

None — this plan and its [goal](../goals/bulk-retrieval-controls.md) are complete.
