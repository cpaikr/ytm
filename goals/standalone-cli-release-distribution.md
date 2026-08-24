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

- Unified version, changelog, tag, visibility, and failure lifecycle — merged
  by PR #20 at `e879f96` after complete CI and feedback closure.

## Execution status

### Completed included results

_None._

### Current in-scope result

CI-built CLI archives, checksums, and generated installers for every claimed
target.

### Next in-scope action

Define the standalone CLI target authority and implement deterministic archive,
checksum, and installer generation without creating external release state.

### Evidence and blockers

- `dev` is the integration branch. It was fast-forwarded to the accepted
  planning state before goal initialization.
- GitHub reports no branch protection or repository ruleset on `dev`, so the
  direct initialization and terminal bookkeeping pushes required by the goal
  lifecycle are available.
- Release Please is the selected product version, changelog, release-PR, tag,
  and draft-Release authority. Its preparation phase is disabled by repository
  variable and explicitly skips GitHub Release creation.
- `VERSION` and the root `CHANGELOG.md` are the single human-readable product
  authorities. Repository validation reconciles their complete Cargo, Node,
  native-package, Bun, and consumer-lock update set.
- The protected release phase will force-create an immutable `vX.Y.Z` tag and
  draft Release; incomplete candidates remain draft, GitHub publication is the
  canonical completion point, and npm follows as a same-source projection.
- Marker-based Release Please updates preserve exact internal Rust dependency
  requirements, and generated third-party notices exclude first-party workspace
  versions so an approved version bump cannot stale release receipts.
- The complete repository validation suite and post-fix code review pass for
  this slice; no Bucket I or Bucket II findings remain.
- PR #20 merged into `dev` as `e879f96` after all 13 CI jobs passed and both
  CodeRabbit findings were fixed, replied to, and resolved.
