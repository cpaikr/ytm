# Goal: Standalone CLI release distribution

Status: complete (historical delivery)
Planning scope: ROADMAP.md

The original contract and evidence below describe its completed delivery. The
[release migration](../plans/release-delivery.md) supersedes its Release Please
and registry-publication design; [release operations](../docs/release.md) are
maintained separately.

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
- CI-built CLI archives, checksums, and generated installers for every claimed
  target — merged by PR #21 at `2150e0f` after complete native CI and feedback
  closure.
- Toolchain-free receipts and safe, recoverable upgrade behavior — merged by
  PR #22 at `8c2a31b` after all 19 CI jobs passed and all eight review threads
  were fixed, replied to, and resolved.
- Exact-distributable consumer tests, integrity checks, and failure injection —
  merged by PR #23 at `3270024` after all 23 CI jobs passed and feedback intake
  closed without actionable review findings.
- Tagged-source GitHub Release workflow and same-version npm publication —
  merged by PR #24 at `c04c1332efa4ec5a4b14b262d232da3378de4992`
  after all 23 CI jobs passed and all ten review threads were fixed, replied to,
  and resolved.
- Consolidated validation, superseded-path removal, and truthful documentation
  — merged by PR #25 at `753dc4dbdae796d2b7d66a35b433b637cf5e9c95`
  after all 23 CI jobs passed and both automated review surfaces closed without
  actionable findings.

## Execution status

### Completed included results

- Unified version, changelog, tag, visibility, and failure lifecycle.
- CI-built CLI archives, checksums, and generated installers for every claimed
  target.
- Toolchain-free receipts and safe, recoverable upgrade behavior.
- Exact-distributable consumer tests, integrity checks, and failure injection.
- Tagged-source GitHub Release workflow and same-version npm publication.
- Consolidated validation, superseded-path removal, and truthful documentation.

### Current in-scope result

None. Every included result is delivered.

### Next in-scope action

None. Selecting or publishing a release and enabling production providers
remain explicitly excluded from this goal.

### Evidence and exclusions

- `dev` is the integration branch. It was fast-forwarded to the accepted
  planning state before goal initialization.
- GitHub reports no branch protection or repository ruleset on `dev`, so the
  direct initialization and terminal bookkeeping pushes required by the goal
  lifecycle are available.
- Release Please owns product version, changelog, and release-PR preparation.
  Its preparation phase is disabled by repository variable and explicitly
  skips tag and GitHub Release creation; the repository-owned publication
  policy binds the exact approved merge commit to the tag and deterministic
  draft.
- `VERSION` and the root `CHANGELOG.md` are the single human-readable product
  authorities. Repository validation reconciles their complete Cargo, Node,
  native-package, Bun, and consumer-lock update set.
- The protected release phase creates the exact absent `vX.Y.Z` tag at the
  approved merge commit and creates or resumes its deterministic draft Release;
  incomplete candidates remain draft, GitHub publication is the canonical
  completion point, and npm follows as a same-source projection.
- Marker-based Release Please updates preserve exact internal Rust dependency
  requirements, and generated third-party notices exclude first-party workspace
  versions so an approved version bump cannot stale release receipts.
- The complete repository validation suite and post-fix code review pass for
  this slice; no Bucket I or Bucket II findings remain.
- PR #20 merged into `dev` as `e879f96` after all 13 CI jobs passed and both
  CodeRabbit findings were fixed, replied to, and resolved.
- The CLI target manifest now claims Linux x64/arm64 on glibc 2.28, macOS arm64,
  and Windows x64. CI builds every archive on its native or policy-compatible
  runner, validates executable identity and archive metadata, then generates a
  canonical checksum manifest and platform installers from the exact archive
  set.
- PR #21 merged into `dev` as `2150e0f` after all 19 CI jobs passed. Seven
  CodeRabbit findings were fixed, replied to, and resolved; one hidden-path
  report was rejected with completed-run evidence. A transient Zig AArch64
  backend failure passed on the isolated retry without a code change.
- The shared managed-install receipt records the installed version, target,
  binary path, canonical GitHub Release URL, and SHA-256. `upgrade --check` and
  `upgrade` validate canonical release assets before replacing either state.
- Unix and Windows installers use recoverable binary-and-receipt transactions.
  Windows adds atomic no-BOM status commits plus ownership markers so
  interrupted detached upgrades can restore the last known-good state without
  consuming stale evidence.
- PR #22 merged into `dev` as `8c2a31b` after the complete local validation
  suite and a clean four-lens code review. All 19 CI jobs passed, and all eight
  review threads were fixed, replied to, and resolved.
- The manifest-derived downstream CLI consumer matrix now downloads the exact
  complete candidate on every claimed native target without rebuilding it. It
  proves executable and receipt identity, version/help execution, failed
  downloads, corrupt archives, managed replacement, rollback, interruption,
  restoration, Windows status ownership, and terminal-status publication
  failure with bounded single-anchor installer copies.
- Native Windows execution exposed and closed two distributable defects:
  module-autoload-dependent hashing and terminal status replacement without an
  explicit backup path. Uncommitted terminal status now preserves the helper
  source and a sanitized marker diagnostic while post-commit cleanup cannot
  misclassify a published result.
- PR #23 merged into `dev` as `3270024` after all 23 CI jobs passed. Codex
  approved, CodeRabbit produced no actionable comments, no review threads were
  opened, and two independent final code-review passes left no Bucket I or
  Bucket II findings.
- The protected tagged-source workflow now rebuilds the complete standalone CLI
  and five-tarball npm candidates from the immutable approved tag, validates
  their exact consumers, publishes GitHub canonically, and only then projects
  the same version to npm through OIDC. Recovery is fail-closed for divergent
  tags, assets, metadata, or partial npm state while byte-identical draft assets
  remain additively recoverable.
- PR #24 merged into `dev` as
  `c04c1332efa4ec5a4b14b262d232da3378de4992` after all 23 CI jobs passed.
  Codex's publication-URL defect and nine CodeRabbit findings were fixed; all
  ten review threads were replied to and resolved, and the final feedback
  collector found no new actionable findings on `bda2211`.
- `bun run validate` is the single complete uncredentialed repository gate for
  local development, ordinary CI, and immutable tagged-source validation. Its
  manifest, fail-fast runner, callers, command set, pinned prerequisites, and
  long-lived CI branches are statically enforced by release validation.
- Superseded migration-branch triggers and stale roadmap or release claims are
  removed. `README.md`, `ARCHITECTURE.md`, `docs/release.md`, `ROADMAP.md`, and
  the completed delivery plan now describe the implemented but deliberately
  disabled lifecycle and its operational boundary.
- PR #25 merged into `dev` as
  `753dc4dbdae796d2b7d66a35b433b637cf5e9c95` after all 23 CI jobs passed.
  Codex approved, CodeRabbit generated no actionable comments, no review
  threads were opened, and two independent final code-review passes found no
  Bucket I or Bucket II issues.
- No release version was selected or published, and no production provider was
  enabled, consistent with the goal's explicit exclusions.
