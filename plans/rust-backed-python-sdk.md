# Rust-backed Python SDK

Status: in progress

## Outcome

`kisnet-ytm` is a first-class, typed Python SDK over `ytm-core`. It offers
idiomatic synchronous and asyncio-native clients without duplicating product
semantics outside Rust, and ships toolchain-free wheels through the unified
product release lifecycle. GitHub Releases remain canonical; PyPI is a
synchronized secondary projection of the same version and tagged source.

## Current state

- Typed `Client` and `AsyncClient` now delegate through a private PyO3 binding
  to the public Rust SDK. Their local fixture wheel passes isolated behavior,
  cancellation, cleanup, and panic-containment tests; a release wheel passes
  offline consumer and strict typing checks on local macOS ARM64/CPython 3.11.
- Python package and binding versions join the single `VERSION` reconciliation.
  Repository validation includes the Python foundation and release fixture guard.
- The foundation passed full repository validation and bounded code/documentation
  review; PR delivery remains before acceptance into dev.
  Portable target/interpreter coverage, deterministic wheel aggregation, and
  unified GitHub/PyPI infrastructure remain unimplemented.
- Historical PyPI `kisnet-ytm` 0.2.0 has a different pure-Python API and remains
  unchanged. No new product version is selected or published.

## Decisions and invariants

- This is a clean replacement. The historical import namespace, functions,
  models, and exception names are not compatibility requirements.
- Retain the PyPI distribution name `kisnet-ytm`; choose the import namespace
  and public symbols for the desired API rather than historical compatibility.
- Rust remains the sole semantic implementation. A narrow PyO3 extension is
  private implementation detail behind a typed, idiomatic Python facade.
- Provide both asyncio-native and synchronous interfaces. Cancellation,
  object lifetime, cleanup, and runtime ownership must be explicit; Rust
  panics must not cross the extension boundary.
- Python exposes a stable project-owned exception hierarchy instead of leaking
  binding, runtime, transport, or parser implementation errors.
- Support CPython 3.11 and newer. Prefer one `abi3` wheel per target when the
  required PyO3 and async behavior are compatible with that boundary.
- The claimed native matrix is GNU/Linux x64 and ARM64 at glibc 2.28, macOS
  ARM64, and Windows x64. Every claimed wheel must be built and exercised on
  its native runner without requiring Rust or repository source.
- Python joins the existing `VERSION`, root changelog, Release Please,
  `vX.Y.Z` tag, deterministic GitHub Release, visibility, and failure
  lifecycle. PyPI publication may begin only after canonical GitHub
  publication and must retain the same version and source identity.

## Included results

1. A private PyO3 extension delegates to `ytm-core`; a public typed Python
   package owns sync and async clients, Python-native values, stable errors,
   cancellation, cleanup, and typing artifacts.
2. Maturin-backed packaging produces deterministic, toolchain-free wheels for
   every declared Python target, with one authoritative machine-readable
   target matrix and enforced Linux compatibility floor.
3. Exact-wheel clean consumers install untouched candidates for every
   supported target and Python version and verify installability, public
   lifecycle, typing, and safe boundary failures. Isolated fixture builds prove
   deterministic source behavior, in-flight cancellation, error translation,
   and panic containment; release artifacts cannot enable injection facilities.
4. Product-version and changelog reconciliation include all Python metadata;
   tagged-source release jobs rebuild, aggregate, integrity-check, and test the
   complete wheel set before GitHub becomes public.
5. PyPI is a same-version secondary projection with trusted publication,
   version-absence checks, explicit partial-failure handling, and no authority
   to select or publish an actual release from repository validation.
6. Architecture, API, installation, development, validation, and release
   documentation describe only the implemented Python surface and lifecycle;
   historical statements that Python is absent are removed or rewritten.

## Implementation slices

The accepted [mytech guidance](https://github.com/sjunepark/mytech/blob/73dac554c5fb74da0fba7a986b4c55e2234d8859/architecture/rust-cores-for-python-packages.md)
is the architecture baseline. It is reusable guidance, not a downstream
application or a requirement to preserve the old Python API. The existing
public Rust exports in `crates/ytm-core/src/lib.rs` are the binding seam;
`packages/node/src/client.d.ts` is useful parity evidence, not Python API design.

### Binding and client foundation

- [x] Add `crates/ytm-python` and a mixed package under `packages/python`.
  Keep the native module private and consume only the public core API.
- [x] Define the public import namespace, sync and async client names,
  keyword arguments, result types, and error hierarchy in the package's API
  specification before implementing their boundary tests. Use Python-native
  naming and typed values for matrix, kinds, date resolution, source metadata,
  yields, and missing values; preserve the core's result information.
- [x] Expose matrix lookup and kind discovery with exact-date and bounded
  previous-available behavior. Python validates Python call shapes; Rust owns
  domain validation, kind resolution, transport, parsing, and fallback.
- [x] Implement asyncio awaitables with a maintained runtime bridge and a
  synchronous interface that releases the interpreter while Rust blocks.
  Document runtime ownership, event-loop affinity, concurrent-call behavior,
  context managers, idempotent close, calls after close, and active-call cleanup.
  Avoid per-call runtime creation and nested event-loop execution.
- [x] Propagate asyncio cancellation to the core cancellation token and retain
  Python cancellation semantics. Translate expected failures into stable safe
  exceptions; contain panics at both synchronous and asynchronous native entry
  boundaries without exposing panic or dependency details.
- [x] Prove public sync/async success, invalid inputs without network access,
  missing data, fallback, error metadata, cancellation during work, and cleanup
  with process-level tests using the existing isolated judge approach.
  Keep fixture transport and panic injection absent from release artifacts.

Exit: both interfaces work against one Rust implementation, lifecycle behavior
is explicit and tested, and a local mixed wheel includes the typed facade.
Resolve exact dependency versions and `abi3` compatibility from current official
documentation and a binding build during implementation, before freezing the
wheel matrix; do not claim compatibility solely from this plan.

### Portable wheels and exact consumers

- [ ] Add one machine-readable Python target authority covering declared
  OS/CPU/libc targets and supported stable CPython versions starting at 3.11.
  Explicitly enumerate the versions validated at delivery; future interpreter
  releases require evidence before joining the supported matrix. Alternative
  interpreters and free-threaded builds are outside the initial claim.
- [ ] Use maturin to build mixed wheels, preferring `abi3` only when the
  binding/runtime combination passes its compatibility gate. Otherwise build
  version-specific wheels without reducing declared interpreter coverage.
- [ ] Enforce glibc 2.28, architecture identity, native dependencies, metadata,
  typing files (`py.typed` and any required stubs), licenses, and package version.
  Verify derived binding artifacts are fresh. Normalize build inputs and
  candidate metadata and validate the untouched wheel bytes by checksum.
- [ ] Build all declared targets in CI and install each exact candidate into
  clean environments for every supported interpreter. Consumers must have
  neither Rust nor the repository on their import path and must not rebuild.
- [ ] Check imports, typed usage with the selected type checker, public client
  construction/lifecycle, safe input failures, and wheel/native identity.
  Run deterministic source-behavior and injected-panic scenarios in isolated
  test builds; assert that release wheels cannot enable those facilities.
  Release-wheel tests and fixture-build tests provide distinct evidence.

Exit: the entire declared matrix installs and exercises the public package;
missing/wrong-target wheels or stale typing fail CI. An sdist cannot substitute
for a claimed wheel. Reuse existing CI aggregation/consumer conventions rather
than introduce a second release framework.

### Unified release candidate and PyPI projection

- [ ] Extend `VERSION` reconciliation, Release Please update paths, changelog
  checks, and lock/metadata validation to Python without creating an independent
  Python version authority or reviving `python-v*` release selection.
- [ ] Extend tagged-source builds and aggregation to require the complete wheel
  set alongside existing CLI and npm assets. Validate checksums, exact version,
  source identity, missing/extra artifacts, and exact consumers before canonical
  GitHub visibility. Keep existing CLI/Node acceptance gates intact.
- [ ] Add disabled-by-default PyPI trusted publication after canonical GitHub
  publication, with exact version-absence checks and immutable asset identity.
  Extend the release state model to cover independent npm/PyPI projection
  outcomes. A completed projection is verified and left intact; a missing
  projection may proceed only under its absence rules; conflicting or partial
  registry state fails closed with explicit recovery guidance.
- [ ] Exercise publication logic without credentials or external writes using
  missing/corrupt wheels, duplicate versions, divergent tagged source, partial
  uploads, and failures before/after canonical visibility and either registry
  projection. State precisely which cases can resume and which need a newly
  authorized version; never overwrite published bytes.

Exit: repository validation proves the complete candidate and failure policy;
actual release selection, provider configuration, and publication remain
separately authorized operations.

### Documentation and delivery closure

- [ ] Extend `bun run validate` through the existing validation owner; add
  targeted Python behavior, artifact, and release checks rather than a parallel
  all-checks entry point. Preserve existing Rust/CLI/Node checks.
- [ ] Update root architecture/specification, Python API and installation docs,
  development commands, and `docs/release.md` to match implemented behavior.
  Clearly distinguish installable historical registry artifacts from the new
  source until an actual rewritten release exists.
- [ ] Remove superseded Python-absence claims only as each claim becomes false.
  Preserve historical artifacts and tags; do not add compatibility wrappers,
  another HTTP implementation, or Python-specific provider policy.
- [ ] Deliver the fewest coherent reviewable slices to `dev` under separately
  authorized execution. For each slice run required checks, one bounded review,
  documentation reconciliation, and initial PR review; resolve CI/feedback
  before recording accepted delivery. Record PRs and accepted SHAs here.
- [ ] Close this plan only after every included result and completion criterion
  is met; a working local binding alone does not complete Python delivery.

## Completion criteria

- The Python facade is typed, documented, and behaviorally backed by
  `ytm-core`, with both sync and async end-to-end tests.
- Clean consumers install the exact release-candidate wheels and run without a
  Rust toolchain, repository checkout, or wheel rebuild on every claimed
  target and supported Python version.
- Integrity, missing-artifact, duplicate-version, cancellation, runtime,
  translated-error, panic, and partial-publication failures are injected and
  fail closed at their owning boundaries.
- The unified release candidate proves version, tagged-source, complete asset,
  and registry-absence identity before each visibility transition.
- Repository-required validation and review pass, superseded paths and claims
  are removed, and planning and delivery documentation are truthful.

## Excluded authority

- Selecting, tagging, or publishing an actual product version.
- Enabling Release Please, GitHub publication, PyPI trusted publishing,
  protected environments, or other production provider state.
- Compatibility with the historical Python API, import namespace, or symbols.
- Expanding the product API, provider support, native target matrix, or
  minimum Python version beyond what the SDK requires.

## Next action

Finish validation of the reviewed foundation on `codex/python-sdk-foundation`,
then create its PR against dev, resolve CI/feedback, and merge preserving
commits before starting the portable-wheel and unified-release slice.
