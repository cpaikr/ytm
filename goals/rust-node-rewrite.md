# Goal: Deliver cutover-ready Node-only ytm

Status: active
Planning scope: ROADMAP.md

## Original contract

Goal contract

- Outcome: Deliver cutover-ready Node-only ytm with a Rust HTTP core, Node-API binding, and thin Node adapters.
- Goal state: goals/rust-node-rewrite.md
- Included results and sources (semantic results define scope; paths supply detail):
  - Baseline/workspace — ROADMAP.md; plans/rust-node-rewrite.md
  - Judge and Rust feasibility — plans/rust-node-rewrite.md; SPEC.md
  - Wire authority, architecture, provider qualification — plans/rust-node-rewrite.md
  - Rust core and Node product — plans/rust-node-rewrite.md; SPEC.md
  - Parity, packaging, kind 80 — plans/rust-node-rewrite.md; contracts/kisnet/; GitHub issue #7
  - Node cutover and legacy retirement — plans/rust-node-rewrite.md; docs/release.md
- Complete when: Every included result achieves its cited outcome and applicable completion criteria within its named semantic boundary; repository-required validation and review pass; planning is truthful; Delivery finishes.
- Excluded: Final main/release PR merge, npm publication, PyPI deprecation, and any replacement Python implementation or API.
- Authority: Execute only included results and necessary supporting work; resolve remaining decisions within that closed outcome using best judgment; record anything else and ask before scope expansion or external authority.
- Resume: Initialize this contract with $progress goal mode before work; recover it before every resume, continuation, compaction, or handoff; stop if recovery fails.
  - Delivery: PR delivery — use $progress's PR lifecycle and the fewest sequential reviewable PRs; finish each through $create-pr and $address-pr-feedback before starting the next, including the final implementation slice.

## Authorized amendments

- 2026-08-20 — Transfer GitHub repository `sjunepark/ytm` to `cpaikr/ytm`
  and use the lowest suitable Blacksmith runner for compatible Actions jobs.
- 2026-08-20 — Keep the native matrix simple: Linux GNU x64/ARM64, macOS
  ARM64, and Windows x64. Do not claim Intel macOS or add Rosetta emulation.
- 2026-08-20 — Remove Release Please. Release-PR/tag creation stays disabled;
  future version selection, tagging, and publication require separate authority.

## Execution status

### Completed results

- Baseline/workspace — PR #8 merged to `main` as `81a60e0`; the validated
  baseline is preserved at `archive/pre-rewrite-2026-08-20`.
- Judge/feasibility and wire/architecture/provider foundation — PR #9 merged
  to `codex/rewrite-vnext` as `63282fc`. The disposable rustls probe reproduced
  both live operations, OpenAPI became the enforced sole wire authority, and
  the source was classified protocol-feasible but not production-qualified.
- Rust core, Node product, parity, packaging, and kind 80 — PR #10 merged to
  `codex/rewrite-vnext` as `63c344f`. Its final head passed all 12 clean native
  consumers on the four Blacksmith targets under Node 22/24/26, the 76-scenario
  public judge, 19 Rust tests, security/dependency gates, production live smoke,
  and the full PR feedback lifecycle.
- Repository transfer — GitHub repository ID `1264066471`, PRs, issue #7,
  branches, and Actions now live at `cpaikr/ytm`; the local remote is canonical.
  Release Please is disabled and removed.

### Current result

Node cutover and legacy retirement — PR #11 is open from
`codex/rewrite-cutover` to `codex/rewrite-vnext`. Its initial Blacksmith run is
green; review-feedback hardening is implemented locally for the follow-up run.

### Current evidence

- The Rust-backed Node package is promoted to `packages/node`; its four native
  packages are under `packages/native`. Legacy Node HTTP/XML code, Python
  source/package/tests, linked Python workflow, Release Please metadata, and
  obsolete migration documents are removed in the same cutover slice.
- CI and live smoke are Node/Rust-only on the lowest suitable Blacksmith images.
  The retained tag-only npm workflow builds and clean-installs every native
  artifact before root assembly; publication remains excluded and uses the
  required GitHub-hosted OIDC runner only if separately authorized.
- The approved PR #10 public projections plus the explicit kind-80 fallback
  acceptance case are frozen as 77 full golden results.
  The active single-product judge verifies every public CLI/toolset outcome,
  including `source`, and rejects a deliberate source-envelope corruption.
- The pre-PR local pass covers frozen Bun state, contract/release/build
  freshness, 77 public scenarios, deliberate oracle corruption, Rust
  formatting/Clippy/19 tests, RustSec and dependency policy, native licenses,
  root package contents, macOS ARM64 clean install on Node 26, workflow parsing,
  diff checks, and a metadata-only production live lookup.
- PR #11's initial remote run passed `validate` and all 12 supported-target
  consumers. Feedback hardening now rejects duplicate golden keys and malformed
  successful JSON, guarantees temporary cleanup, normalizes nondeterministic
  stderr evidence, validates required root-tarball entries and the scoped Node
  lock entry, bounds CI, and decodes live-smoke stdin as UTF-8.
- `main` branch protection now requires the app-pinned `validate` context only;
  retired Python contexts are removed while strict checks, administrator
  enforcement, conversation resolution, and force-push/deletion bans remain.

### Next action

Push and validate the PR #11 feedback commit, finish every review thread, and
merge the completed cutover into `codex/rewrite-vnext`. Then open the reviewed
integration-to-`main` PR and leave that final main merge unperformed as
required.

### Blockers

None.
