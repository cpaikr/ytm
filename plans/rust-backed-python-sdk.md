# Rust-backed Python SDK

Status: planned

## Outcome

`kisnet-ytm` is a first-class, typed Python SDK over `ytm-core`. It offers
idiomatic synchronous and asyncio-native clients without duplicating product
semantics outside Rust, and ships toolchain-free wheels through the unified
product release lifecycle. GitHub Releases remain canonical; PyPI is a
synchronized secondary projection of the same version and tagged source.

## Current state

- `ytm-core` owns the asynchronous matrix and kind-discovery behavior used by
  the standalone CLI and the typed Node client.
- PyPI contains the historical pure-Python `kisnet-ytm` 0.2.0 distribution,
  but its source, CI, smoke tests, and publishing path are absent from the
  active repository.
- The implemented release lifecycle currently builds exact CLI and Node
  distributables only. Python version reconciliation, wheels, consumers, and
  PyPI projection do not yet exist.

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
3. Exact-wheel clean consumers install the untouched candidates for every
   supported target and Python version and exercise public behavior, typing
   availability, error translation, cancellation, cleanup, and panic
   containment.
4. Product-version and changelog reconciliation include all Python metadata;
   tagged-source release jobs rebuild, aggregate, integrity-check, and test the
   complete wheel set before GitHub becomes public.
5. PyPI is a same-version secondary projection with trusted publication,
   version-absence checks, explicit partial-failure handling, and no authority
   to select or publish an actual release from repository validation.
6. Architecture, API, installation, development, validation, and release
   documentation describe only the implemented Python surface and lifecycle;
   historical statements that Python is absent are removed or rewritten.

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

Design and implement the private binding and public sync/async package
foundation against `ytm-core`, then extend exact-wheel validation and the
unified tagged-source release lifecycle through the same reviewed goal.
