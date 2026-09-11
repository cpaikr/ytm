# Roadmap

This file owns active delivery order and routes completed work to its records.
[SPEC](SPEC.md) owns implemented product behavior;
[architecture](ARCHITECTURE.md) owns structure and boundaries.

## Remaining work

- [Production provider enablement](tasks/resolve-production-provider-enablement.md):
   an owner rights-and-operations decision remains required.

## Completed delivery

- [Windows installation visibility](plans/windows-installation-visibility.md):
  delivered and accepted; independent Windows/MSIX validation remains an
  explicit evidence limitation.

- [CLI release migration](plans/release-delivery.md): completed; ongoing release
  operations belong to the [runbook](docs/release.md), and published artifacts
  to [GitHub Releases](https://github.com/cpaikr/ytm/releases).
- [Bulk retrieval controls](plans/bulk-retrieval-controls.md) and
  [retrieval recovery and live acceptance](plans/resilient-history-retrieval.md).
- [Count-based history](plans/count-based-ytm-history.md),
  [multi-date history](plans/multi-date-ytm-history.md), and
  [CLI Excel export](plans/cli-excel-export.md).
- [Python SDK](plans/rust-backed-python-sdk.md),
  [project hardening](plans/deliver-project-hardening.md),
  [post-migration smoke reconciliation](plans/confirm-post-migration-live-smoke.md),
  and [original CLI distribution](plans/standalone-cli-release-distribution.md).

Completed plans retain delivery evidence and link to their immutable goal
contracts where applicable. Their historical exclusions do not describe later
release status or authorize additional work.
