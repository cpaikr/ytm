# Reconcile post-migration live-smoke evidence

Status: in progress

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

GitHub metadata and the workflow at the exact SHA confirm the `rust-cli` job
built the CLI and passed its nonempty successful-result assertion, completing
at `2026-09-04T05:56:49Z`. Git ancestry confirms both public SDK `dd683fc` and
CLI migration `8465077` precede this revision. The provider ledger now records
that verified result while preserving the qualification decision; reviewed
remote integration remains pending. No provider request or response-body
collection was used during reconciliation.

## Execution and acceptance

- [x] Verify the cited run's conclusion, source SHA, workflow, and ancestry
  include the public Rust SDK and standalone CLI migration. Use bounded
  metadata; do not collect response bodies, rows, or yields.
- [x] Replace the obsolete pending-run paragraph in the provider ledger with
  the verified run URL, UTC date, SHA, and operational conclusion. Describe it
  as a confirmed post-migration success; do not claim it was chronologically
  first unless run history establishes that fact.
- [x] Preserve the provider's `protocol-feasible; not production-qualified`
  decision and all unresolved rights-and-operations questions.
- [x] Check local links and evidence consistency, run one bounded documentation
  review, and reconcile references affected by the task-to-plan move.
- [ ] Deliver the documentation change through the authorized repository
  workflow; record its accepted revision. Mark this item complete and remove
  its active roadmap link while retaining the evidence in the provider ledger.

If the cited run cannot be verified or has unsuitable lineage, record that
specific gap and inspect another existing eligible run. Scheduling or
executing a fresh live request is not a fallback authorized by this plan.

## Next action

Finish the bounded documentation review and deliver the ledger update with the
hardening PR. Record the accepted revision after merge, then remove this plan
from the active roadmap.
