# Rust-backed Python SDK

Status: complete

## Outcome

`kisnet-ytm` is a first-class, typed Python SDK over `ytm-core`, with synchronous
and asyncio clients, portable toolchain-free wheels, and unified release
infrastructure. GitHub Releases are canonical; independently gated PyPI
publication projects the same immutable version and tagged-source assets.

## Current state

Delivered to dev through two sequential PRs, preserving individual commits:

- [PR #29](https://github.com/cpaikr/ytm/pull/29), foundation, merged at
  `8ad5ddeec0b3564e9270ab0111c9fa10a1809149` after all 23 CI jobs passed.
- [PR #30](https://github.com/cpaikr/ytm/pull/30), portable wheels and unified
  release/PyPI infrastructure, merged at
  `f63666b094543f9be722c546fff786593af9847d` after all 45 final-head jobs in
  [CI run 34014129565](https://github.com/cpaikr/ytm/actions/runs/34014129565) passed.

Full local validation, bounded implementation reviews, documentation
reconciliation, and reviewer feedback closure passed. Codex completed clean;
CodeRabbit acknowledged and resolved the final PR's three findings.

## Accepted coverage

- The private PyO3 binding delegates product semantics to the Rust SDK. Typed
  `Client` and `AsyncClient` expose Python-native results and stable errors;
  isolated fixture processes prove success, fallback, cancellation, cleanup,
  active-call lifecycle, error translation, and panic containment.
- [`python-targets.json`](../python-targets.json) owns four native targets and
  conventional CPython 3.11–3.14. Every native job produces byte-identical fresh
  `cp311-abi3` wheels, enforces architecture/dependencies and glibc 2.28 where
  applicable, and verifies metadata, typing, licenses, RECORD and source identity.
- Every exact wheel passes clean consumers on every declared interpreter,
  without Rust on PATH, repository imports, or rebuilding. Consumers verify
  public lifecycle, safe errors, strict typing, native identity, and that release
  artifacts cannot enable fixture or panic injection.
- Python joins the single VERSION/changelog/Release Please authority. Tagged
  builds and exact consumers gate the complete CLI/npm/Python canonical asset
  set before GitHub visibility. Checks enforce complete asset names, versions,
  source identity and immutable digests.
- Independent npm/PyPI projections preserve completed exact sets and permit
  publication only for wholly absent versions. Missing/corrupt artifacts,
  divergent source, duplicate/conflicting versions, partial uploads, transient
  propagation, and failures around visibility are covered without external writes.
- [Python API documentation](../packages/python/SPEC.md),
  [installation guidance](../packages/python/README.md), root architecture and
  specification, and [release policy](../docs/release.md) own current behavior.
  Superseded Python-absence claims are removed.

## Retained boundaries

Historical PyPI 0.2.0 and component tags remain immutable and expose a different
API. No compatibility layer, independent Python product version, or duplicate
provider implementation was introduced. A rewritten PyPI release requires a
separately approved version above 0.2.0.

Actual version selection, tagging, release activation/publication, protected
provider configuration, and production provider enablement were excluded and
remain unperformed. Future interpreters, free-threaded builds, and additional
native targets require separate evidence and scope.

## Next action

None — complete.
