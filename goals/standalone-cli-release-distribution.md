# Goal: Standalone CLI release distribution

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Implement the complete standalone CLI distribution lifecycle, with GitHub Releases as the canonical channel and npm as a synchronized secondary projection.
- Goal state: goals/standalone-cli-release-distribution.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Unified version, changelog, tag, visibility, and failure lifecycle — plans/standalone-cli-release-distribution.md; docs/release.md
  - CI-built CLI archives, checksums, and generated installers for every claimed target — plans/standalone-cli-release-distribution.md; native-targets.json
  - Toolchain-free receipts and safe, recoverable upgrade behavior — plans/standalone-cli-release-distribution.md; SPEC.md
  - Exact-distributable consumer tests, integrity checks, and failure injection — plans/standalone-cli-release-distribution.md
  - Tagged-source GitHub Release workflow and same-version npm publication — .github/workflows/release.yml; docs/release.md
  - Consolidated validation, superseded-path removal, and truthful documentation — ROADMAP.md; ARCHITECTURE.md; README.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Selecting or publishing an actual release version; production provider enablement.
- Authority: Execute only included results and necessary supporting work; resolve remaining decisions within that closed outcome using best judgment; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
- Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

_None._

## Execution status

### Completed included results

_None._

### Current in-scope result

Unified version, changelog, tag, visibility, and failure lifecycle.

### Next in-scope action

Decide and encode the release authority and lifecycle without creating a tag,
release, or registry publication.

### Evidence and blockers

- `dev` is the integration branch. It was fast-forwarded to the accepted
  planning state before goal initialization.
- GitHub reports no branch protection or repository ruleset on `dev`, so the
  direct initialization and terminal bookkeeping pushes required by the goal
  lifecycle are available.
