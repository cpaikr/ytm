# Goal: Observable and configurable bulk retrieval

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract
- Outcome: Make bulk YTM retrieval observable and configurable across CLI, Rust, Node, and Python while preserving default request behavior and data selection.
- Goal state: goals/bulk-retrieval-controls.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Bounded retry configuration and optional request pacing — plans/bulk-retrieval-controls.md
  - Metadata-only progress and final retrieval statistics on every public surface — plans/bulk-retrieval-controls.md
  - Deterministic 180-date acceptance, interface validation, and contract documentation — plans/bulk-retrieval-controls.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Release publication.
- Authority: Execute only included results and necessary supporting work; record anything else and ask before scope expansion or external actions not covered by this contract and Delivery.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

_None._

## Execution status

### Completed included results

- Bounded configurable retries and optional invocation-local request pacing.
- Metadata-only pull progress and final retrieval statistics across Rust, CLI,
  Node, Python sync and async, with preserved selection and default policy.
- Deterministic 180-date acceptance, public-interface validation, and reconciled
  contracts, API references and operational-history wording.

### Current in-scope result

PR delivery of the single connected implementation slice.

### Next in-scope action

Create the PR, await CI and initial CodeRabbit review, resolve feedback, and merge
into `codex/bulk-controls-integration`. Then persist terminal planning metadata.

### Evidence and blockers

- Native goal belongs to task `01a08b2a-0b94-7063-854d-5041fce8e61c`.
- Startup checkout was exactly preparation commit
  `ff9bad63bcda132bf1132af377bf9a506d48b806`. Goal initialization was committed
  and pushed to the preflighted integration branch as `7b3343d`; direct terminal
  metadata commit/push is authorized there. Repository reports no rulesets.
- Work branch: `codex/bulk-retrieval-controls`; base:
  `codex/bulk-controls-integration`. All included results form one review slice.
- Repository skills are under `.claude/skills`, replacing the handoff's stale
  `.agents/skills` location; global progress skill owns this contract lifecycle.
- Progress uses a single-use pull handle with a constant-memory latest snapshot.
  Intermediate updates coalesce; no user callback runs inside retrieval. Python
  async cancellation drains native work before re-raising the original
  `CancelledError` with final statistics. Pre-start failures omit statistics.
- Core synthetic acceptance: 250 scanned dates, 180 complete qualifying dates,
  1,704 HTTP attempts including 14 retries. Values and ordered requests match an
  unpaced 1,690-attempt baseline. This is synthetic evidence, not a live run.
- Full `bun run validate` passed with CPython 3.12 on macOS ARM64. Public CLI,
  Node, Python sync/async controls and recovery checks passed. The gate includes
  fixture/release wheels, Rust consumers, dependency policy and package checks.
  PowerShell-only Windows guide execution remains outside this host's coverage.
- Independent bounded code review completed. Its one Python close/completion
  statistics-loss finding is fixed and regression-tested; CLI post-retrieval
  cancellation/export errors also retain counters. Affected CLI/Python tests
  and clippy passed. Scoped documentation harmonization and local links passed.
- Candidate: one implementation PR and feedback resolution through merge.
  Classification: necessary. Contract basis: Delivery and Complete when.
  Action: proceed against the preflighted integration branch.
- No release publication, default-branch promotion, or additional live bulk run
  is authorized. No current blocker.
