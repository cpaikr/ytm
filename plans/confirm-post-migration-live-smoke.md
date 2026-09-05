# Reconcile post-migration live-smoke evidence

Status: planned

## Outcome

The provider evidence ledger records a successful post-migration Rust CLI run,
and the completed operational evidence item leaves the active roadmap.
Availability evidence remains distinct from production qualification.

## Current state

GitHub run [33842308744](https://github.com/cpaikr/ytm/actions/runs/33842308744)
succeeded on 2026-09-04 from `main` at
`810250dbf5e9b105cfc1955fe7b94ba7a612b361`. Its `rust-cli` job built the standalone
CLI and passed the live smoke. The workflow at that SHA checks a successful
matrix result with nonempty rows and prints bounded date/count metadata.

`docs/provider-qualification.md` still says no post-migration run has completed.
The operational check has evidence; source-lineage confirmation and durable
ledger reconciliation remain. No new provider request is needed to establish
this already observed result.

## Execution and acceptance

- [ ] Verify the cited run's conclusion, source SHA, workflow, and ancestry
  include the public Rust SDK and standalone CLI migration. Use bounded
  metadata; do not collect response bodies, rows, or yields.
- [ ] Replace the obsolete pending-run paragraph in the provider ledger with
  the verified run URL, UTC date, SHA, and operational conclusion. Describe it
  as a confirmed post-migration success; do not claim it was chronologically
  first unless run history establishes that fact.
- [ ] Preserve the provider's `protocol-feasible; not production-qualified`
  decision and all unresolved rights-and-operations questions.
- [ ] Check local links and evidence consistency, run one bounded documentation
  review, and reconcile references affected by the task-to-plan move.
- [ ] Deliver the documentation change through the authorized repository
  workflow; record its accepted revision. Mark this item complete and remove
  its active roadmap link while retaining the evidence in the provider ledger.

If the cited run cannot be verified or has unsuitable lineage, record that
specific gap and inspect another existing eligible run. Scheduling or
executing a fresh live request is not a fallback authorized by this plan.

## Next action

Confirm source ancestry for the cited successful run, then prepare the precise
provider-ledger replacement when execution is authorized.
