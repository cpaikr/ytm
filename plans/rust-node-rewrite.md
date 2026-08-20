# Rewrite ytm around a Rust HTTP core and Node SDK

## Outcome

`ytm` becomes a Node.js-only product whose KIS-NET protocol implementation is
owned by one Rust core, exposed through a narrow asynchronous Node-API binding
and an idiomatic TypeScript/JavaScript facade and CLI. A language-neutral HTTP
contract, independent fixtures, black-box parity checks, package-consumer tests,
and live evidence make the rewrite safe to cut over without retaining the old
Node or Python implementations.

## Historical execution record

The bullets in this section preserve the staged evidence through PR #10,
including intermediate failed Windows harness runs. They are superseded by the
current cutover state that follows.

- The shared pre-rewrite baseline landed on `main` through PR #8 at `81a60e0`,
  passed the complete validation and package-artifact gates there, and is
  archived at `archive/pre-rewrite-2026-08-20`. `codex/rewrite-vnext` and its
  sibling worktree now own the isolated rewrite integration line.
- The released product has handwritten Node and Python implementations at
  version `0.2.0`. The existing component tags preserve those published package
  sources.
- The rewrite foundation now names OpenAPI as the sole wire authority, keeps
  fixtures as independent evidence, and enforces the boundary with a contract
  validator and shared evidence-corpus digest.
- A package-manifest-driven black-box judge exercises the public Node toolset
  and CLI in isolated processes. Its reviewed 56-scenario inventory covers the
  legacy parity boundary, and a deliberate null-to-zero mutation proves that
  the judge detects behavioral drift.
- GitHub issue #7 records an upstream-supported private-corporate-bond kind
  (`80`) that both implementations currently reject because discovery results
  are treated as the complete kind catalog.
- Scheduled Node and Python live checks are healthy. Successful requests do not
  yet establish provider rights, quotas, retention rules, or production
  suitability; those require a separate qualification decision.
- The remaining live-metadata item in the historical XML-hardening plan is
  absorbed by the rewrite's transport qualification and live validation.
- A disposable Rust 1.92 vertical slice reproduced both live operations with
  reqwest 0.13.4 over rustls and parsed the independent fixtures with quick-xml
  0.41.0. Sanitized metadata is retained in provider qualification; the probe
  source and all request/response bodies were discarded.
- The complete foundation landed on the rewrite integration branch through PR
  #9 at `63282fc`; the Rust core and Node product are now the active slice.
- PR #10 now contains the Rust HTTP/Nexacro core, Node-API binding, thin
  candidate CLI/toolset, generated four-target native package set, and
  candidate CI matrix. Its review-hardened public judge passes 76 scenarios,
  including kind 80, strict date shapes, missing-native behavior, pre-aborted
  binding cancellation, immutable operation descriptions, formula-safe CSV,
  and the live-observed optional `ColumnInfo` response metadata.
- Nineteen hermetic Rust tests exercise strict XML/profile parsing, OpenAPI request
  conformance, exact HTTP 200, redirect refusal, required headers,
  decompressed-size bounds, and in-flight cancellation. Rust formatting,
  Clippy, tests, advisory audit, license/source policy, and dependency policy
  pass locally.
- A production binding smoke on 2026-08-20 completed both live operations
  without the judge transport and retained sanitized counts and timing only.
  The macOS ARM64 release package also passed a clean npm consumer install on
  Node 26. The first PR matrix passed every native build and all non-Windows
  consumers. Windows builds and assembly pass, while its first two consumer
  attempts exposed harness-only `.cmd` spawning and Node quote-escaping
  incompatibilities before npm ran; the verbatim bounded wrapper awaits the
  repeated Node 22/24/26 delivery check. Selected targets are not yet claimed
  as supported.
- The pending PR follow-up moves every compatible workflow job to the smallest
  Blacksmith runner for its native image, keeps npm's OIDC publish job on the
  GitHub-hosted runner required by npm, removes Release Please automation, and
  updates repository authority to `cpaikr/ytm`. Focused validation and the
  macOS ARM64 clean consumer passed locally before transfer.
- Repository `1264066471`, PR #10, issue #7, branches, secrets, environments,
  protection, and Actions settings now live at `cpaikr/ytm`; the shared remote
  is canonical. Release Please is disabled and its guard is false. The final
  PR head is running the four-target Blacksmith matrix.
- That matrix passed ordinary CI, Linux consumers, and macOS Node 22/24 before
  the Windows harness showed that bare `npm.cmd` resolves npm internals from
  the working directory under the bounded wrapper. Resolve the launcher to its
  absolute PATH entry and repeat the full matrix; native build and assembly
  were already successful.

## Current state

- PR #10 merged to `codex/rewrite-vnext` as `63c344f` after its final
  Blacksmith run passed all 12 supported-target clean consumers under Node
  22/24/26, the complete Rust/parity job, and the feedback lifecycle.
- `codex/rewrite-cutover` promotes the reviewed Rust-backed product to
  `packages/node` and `packages/native`, then removes the legacy JavaScript
  HTTP/XML implementation, Python product/release paths, Release Please, and
  candidate-only staging paths atomically. PR #11 merged to the rewrite
  integration branch as `e858f5f`; its final `validate` job and all 12
  native-consumer contexts passed on Blacksmith, all review threads are
  resolved, and Codex completed review without findings.
- The active judge freezes the reviewed PR #10 public projections plus the
  explicit kind-80 fallback acceptance case as 77 golden results and
  deep-compares every CLI/toolset outcome, including source metadata. A
  deliberate source-envelope mutation proves the oracle fails.
- Node/Rust-only CI and live smoke use the lowest suitable Blacksmith images.
  The retained tag-only npm workflow assembles and clean-installs every native
  package before validating the complete artifact set and the root package.
- `main` branch protection requires the app-pinned `validate` context and all
  12 supported-target/Node consumer contexts. Retired Python checks are removed
  without weakening strict checks, administrator enforcement, conversation
  resolution, platform gates, or branch immutability.
- The pre-PR local pass covers frozen Bun state, contract/release/build
  freshness, 77 public scenarios, deliberate oracle corruption, Rust
  formatting/Clippy/19 tests, RustSec and dependency policy, native licenses,
  root package contents, macOS ARM64 clean install on Node 26, workflow parsing,
  diff checks, and a metadata-only production live lookup. PR feedback
  hardening is integrated and passed the follow-up remote run.

## Decisions

- Keep the existing repository, history, npm package identity, and ordinary Git
  ancestry. Do not use an orphan branch or a new repository.
- After `dev` and `main` have one validated baseline, create an annotated,
  non-release archive tag and a `codex/rewrite-vnext` branch in a sibling
  worktree. Keep the old implementation runnable until parity and cutover.
- Build only the Rust implementation and Node.js product. Do not build a new
  Python implementation, binding, package, or API. Remove Python source,
  documentation, CI, and release automation at cutover; the already-published
  PyPI `0.2.0` remains historical and installable.
- Support Node.js through Node-API. Bun may remain a development package
  manager, but browser, edge, Deno, and Bun runtime compatibility are not
  product requirements.
- Make OpenAPI the sole repository authority for external HTTP wire facts. Keep
  fictional fixtures and independently authored expectations as evidence, not
  as a second authority. If OpenAPI cannot truthfully express a Nexacro detail,
  record the limitation and preserve that fact in an explicitly named,
  language-neutral canonical contract rather than hiding it in code.
- Keep Rust as the sole HTTP conformer. Rust owns request construction,
  transport, bounds, retry policy, XML decoding, domain normalization, and
  failure semantics. The Node-API binding and TypeScript facade own only the
  public boundary and JavaScript ergonomics.
- Preserve the npm package name, `ytm` executable, toolset subpath, machine-mode
  JSON/error contract, retrieval semantics, and deterministic output unless an
  explicit reviewed decision declares a breaking change.
- Adapt Anthropic's migration kit as a redesign: establish a judge before
  implementation, work by subsystem, replace translation rules with target
  architecture, use adversarial design review and a disposable vertical slice,
  and omit the translation bakeoff and per-file agent factory.
- Treat only HTTP 200 as a wire success; Nexacro failures remain protocol
  outcomes inside 200 responses. Disable redirects and automatic transport
  retries, keep the 20-second whole-request deadline and one-mebibyte decoded
  body cap, and perform calls sequentially. User-Agent construction is Rust
  client policy rather than provider-contract authority.
- Preserve `AbortSignal` cancellation but remove the public JavaScript
  `context.fetch` injection seam at cutover. This is an approved breaking
  change required by the single-conformer architecture.
- Raise the cutover runtime floor to Node.js 22 and validate Node 22 and 24 plus
  Node 26 for forward compatibility.
- Select Linux GNU x64/ARM64, macOS ARM64, and Windows x64 for cutover
  validation. Intel macOS is intentionally unclaimed because Blacksmith has no
  native Intel runner and this personal project does not need a Rosetta path.
  Selection becomes support only after native build and clean consumer
  installation on each target; all other platforms remain unclaimed.
- Run protocol/fixture parity once in the platform-neutral Rust/Node validation
  job and run the production artifact through a clean consumer on every
  supported target. The user's simplified personal-project matrix deliberately
  does not duplicate the fixture judge on every OS; platform support is based
  on native build and runtime installation, not redundant protocol execution.
- Keep kind 80 (`회사채(사모)`) in the Rust-owned canonical catalog, distinct
  from kind 70. Discovery may add kinds but cannot remove or redefine a
  canonical entry; conflicts fail as source-format errors.
- Classify the source as protocol-feasible but not production-qualified.
  Bounded scheduled smoke is monitoring, not production authorization; raw
  bodies, rows, request bodies, and yields are not retained as live evidence.
- Keep release-PR and tag automation disabled. At cutover retain the npm
  identity, `release.yml`, and `node-v*` tag namespace; native packages share
  one explicitly approved version and must assemble before the root artifact.
- Refuse to begin a registry release if any root or native package already
  exists at the selected version. Repair a partial publish with a newly
  approved immutable version rather than filling missing packages in place.

## Delivery plan

### 0. Establish the recoverable baseline

- Land the documentation-only `dev` delta on `main` through normal review and
  run the complete validation and package-artifact checks there.
- Create an annotated tag such as `archive/pre-rewrite-2026-08-20` on that exact
  commit. Do not use or move Release Please's `node-v*`, `python-v*`, or `v*`
  tag namespaces.
- Create `codex/rewrite-vnext` in a sibling worktree such as `../ytm-rewrite`.
  Create a `maintenance/0.2` branch only if fixes to the old line are actually
  required during the rewrite.

### 1. Prove feasibility and freeze observable behavior

- Inventory the public Node CLI, toolset export, schemas, errors, package
  contents, source fallback, XML limits, and live behavior. Human-review the
  scenario list before treating it as the parity definition.
- Build a black-box judge that can run the old and new public surfaces with the
  same inputs, without importing implementation internals. Prove that it fails
  against deliberately broken legacy behavior.
- Run a disposable Rust transport/XML vertical slice against fixtures and the
  live source. Treat inability to reproduce the required network behavior as a
  feasibility blocker, not as permission to add a second JavaScript transport.
- Select and document the native package matrix before implementation. At
  minimum, test every declared target through a clean consumer install; do not
  imply support for unbuilt targets.

### 2. Establish target authority and architecture

- Add the narrow OpenAPI contract for the KIS-NET initialization and matrix
  requests, including media types, bounded responses, protocol failures, and
  the exact known/unknown boundary.
- Add `ARCHITECTURE.md` describing the Rust core, binding, facade/CLI,
  generated/projected artifacts, dependency direction, error ownership, and
  clean removal path for the legacy implementations.
- Record provider qualification separately from protocol conformance: source
  status, documented versus observed claims, reuse/attribution, request pacing,
  retries, retention, monitoring, incident response, and withdrawal criteria.
- Define the public compatibility contract and the acceptance case for issue
  #7. Discovery output must not silently override a supported canonical kind.
- Replace linked Node/Python release assumptions with a Node-only release
  design while leaving release-PR and tag creation disabled.

### 3. Implement by subsystem

- Implement bounded Nexacro request/response handling and explicit error types
  in Rust, followed by transport, initialization, kind resolution, matrix
  retrieval, previous-date fallback, and deterministic output projection.
- Add exact OpenAPI conformance and fictional-fixture checks around the Rust
  boundary. Keep unknown external values open where the source is genuinely
  extensible.
- Expose one narrow asynchronous Node-API surface, then rebuild the public
  toolset and CLI as thin TypeScript/JavaScript adapters with no wire behavior.
- Review the high-risk subsystem boundaries independently: wire authority,
  XML parser, transport, kind resolution/fallback, native binding, and public
  adapters. Fix recurring failures in the authority or architecture rather
  than accumulating local exceptions.

### 4. Prove parity and distributability

- Run old-versus-new black-box parity over every accepted scenario, including
  malformed XML, size/encoding bounds, protocol failures, unknown values,
  fallback histories, deterministic CLI output, and issue #7.
- Run real-transport verification separately from ordinary deterministic CI.
  Capture response metadata without persisting response bodies.
- Build npm artifacts for the declared native matrix and test clean installs,
  executable discovery, toolset imports, version/capability/validation
  discovery, stdout/stderr separation, and exit statuses from those artifacts.
- Complete TODO/BUG/PERF review, source/package inspection, security review, and
  a repository-level code review before declaring the candidate cutover-ready.

### 5. Cut over and retire superseded paths

- Switch the npm package, CLI, tests, documentation, CI, and live smoke to the
  new implementation in one reviewable cutover while retaining normal Git
  history.
- Remove the legacy Node transport/parser and all Python implementation,
  package, tests, lockfiles, workflows, release configuration, and claims.
- Reconcile `SPEC.md`, fixtures, generated artifacts, architecture, provider
  decisions, and release docs so every durable concern has one named authority
  and a freshness rule.
- Leave Node release and tag creation disabled. Any future release procedure,
  exact version, external publication, or PyPI deprecation requires separate
  explicit authorization.
- Before publication, undo a failed cutover with an ordinary revert. After
  publication, revert and publish a new corrective version; never move release
  tags or attempt to replace an immutable registry version.

## Completion criteria

- One Rust implementation owns all external HTTP and Nexacro behavior; no
  JavaScript or Python HTTP conformer remains.
- OpenAPI and any explicitly documented Nexacro extension are the named wire
  authority, and all derived artifacts have enforced freshness checks.
- The packaged Node CLI and toolset pass the approved black-box judge, issue #7,
  deterministic fixture tests, supported-target clean installs, and separate
  live verification.
- Provider qualification and production enablement decisions are explicit.
- Python is absent from the active product and release machinery; historical
  releases and source tags remain intact.
- Current architecture, operations, and release documentation contain the
  durable result; migration diaries and superseded plans are closed or reduced
  to history.

## Out of scope

- A replacement Python implementation, extension, package, or API.
- A new repository, orphaned history, or parallel long-term implementation.
- Browser, edge, Deno, or Bun runtime support.
- Publishing a registry release, deprecating the PyPI project, merging the
  final main/release pull request, or changing external provider state without
  explicit authorization. Intermediate rewrite PR delivery to the isolated
  integration branch is part of this plan.

## References

- [Anthropic code migration kit](https://github.com/anthropics/code-migration-kit-with-claude-code/tree/cf91c9d5068d9aaf95a36164169f08c3e636c909)
- [External HTTP contracts and handwritten clients](https://github.com/sjunepark/mytech/blob/d20f8c511979dd0cfcdbf4f046f0b145dce38e79/architecture/external-http-contracts-and-handwritten-clients.md)
- [Rust for external HTTP protocol implementations](https://github.com/sjunepark/mytech/blob/d20f8c511979dd0cfcdbf4f046f0b145dce38e79/architecture/rust-for-external-http-protocols.md)
- [External provider qualification](https://github.com/sjunepark/mytech/blob/d20f8c511979dd0cfcdbf4f046f0b145dce38e79/practices/external-provider-qualification.md)

## Next action

Open the integration-to-`main` promotion PR, complete its CI and feedback
lifecycle, and leave its final merge unperformed.
