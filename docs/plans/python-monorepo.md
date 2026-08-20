# Python Package and Monorepo Plan

Status: complete.

Lifecycle: historical. The Node-only Rust rewrite and removal of the Python
product are tracked in [`plans/rust-node-rewrite.md`](../../plans/rust-node-rewrite.md).

## Current state

`packages/python` now builds `kisnet-ytm` for Python 3.11-3.14 with Pydantic
models, `Decimal` yields, the private curl-cffi source seam, explicit typed
errors, safe logging, and validated previous-date resolution histories. Node
and Python consume the same shared fixtures. Source archives rebuild from their
own extracted contents, and registry workflows resolve component tags once and
pin downstream jobs to the resulting commit. CI covers Python quality, the
supported version matrix, artifacts, and a clean wheel import while preserving
the existing Node check name and npm pack contract. Release Please owns two
linked components. Component tags route immutable commits to separate npm and
PyPI OIDC publishing workflows. Future versions follow the recurring approval
and lockstep flow in `docs/release.md`.

## Objective

Publish a native Python package that retrieves KIS-NET YTM Matrix data without
requiring Node.js. Keep the existing npm CLI and toolset behavior stable while
both language packages share source-protocol fixtures, behavioral invariants,
and one product version.

The planned distribution name is `kisnet-ytm`; callers import `kisnet_ytm`.
The minimum supported Python version is 3.11.

## Target repository shape

```text
.
├── package.json               # private Bun workspace and root commands
├── packages/
│   ├── node/                  # existing @sjunepark/ytm package
│   └── python/
│       ├── pyproject.toml
│       ├── uv.lock
│       ├── src/kisnet_ytm/
│       └── tests/
├── contracts/kisnet/          # shared XML fixtures and expected behavior
├── docs/
├── skills/
└── release-please-config.json
```

Keep the Python `pyproject.toml` and lockfile inside `packages/python` while it
is the repository's only Python package. A root uv workspace is warranted only
after a second Python package needs a shared lock and workspace dependencies.

The root README remains a product-level entry point. Each published package
owns its installation and language-specific usage documentation. The agent
skill remains at the repository root and routes callers to the appropriate
language surface.

## Python interface

Start with a small synchronous interface rather than copying the Node
toolset's generic operation dispatcher:

```python
from datetime import date
from kisnet_ytm import fetch_matrix

matrix = fetch_matrix(
    date(2026, 6, 7),
    "국채",
    previous_available_days=10,
)

print(matrix.base_date)
print(matrix.rows[0].yields["10Y"])
```

The initial public interface consists of:

- `fetch_matrix(base_date, kind, *, previous_available_days=None)`
- `list_kinds(...)`
- Pydantic result models for matrices, rows, kinds, and date resolution
- `YtmError` with specific invalid-input, unavailable-data, source-transport,
  source-protocol, and source-format subclasses

Do not expose curl-cffi sessions, Nexacro records, internal transport types, or
the Node toolset's `execute(operation, input)` shape. Add an asynchronous
interface or a session-owning public client only after a concrete caller needs
one.

## Behavioral invariants

- Exact-date lookup is the default. No result may silently substitute another
  date.
- `previous_available_days=N`, for `0 <= N <= 31`, tries the requested date and
  then at most `N` earlier calendar dates in order.
- Previous-date probing continues only after KIS-NET confirms that matrix data
  is unavailable. Transport, nonzero Nexacro status, and source-format failures
  stop immediately.
- Every signed-integer Nexacro `ErrorCode` other than zero fails closed,
  including positive warnings, and preserves the source code and message.
- Results record the requested date, resolved date, and every attempted date.
- Yield values use `Decimal`; source `-` or empty yield cells become `None`.
- Successful matrices contain at least one row. Invalid numeric cells and
  missing required columns are source-format errors, not missing data.
- 종류 and tenor values remain source-compatible strings rather than closed
  enums, so upstream additions do not require an interface change.
- Python callers never require a Node.js installation or subprocess.

## Runtime seams and dependencies

```text
Python caller
    │
    ▼
public retrieval interface ──► validation and date resolution
    │
    ▼
private KIS-NET source seam
    ├── curl-cffi adapter ──► KIS-NET Nexacro endpoints
    └── fixture adapter    ──► deterministic tests
```

KIS-NET is a true external dependency. The private source seam isolates HTTP,
browser impersonation, Nexacro XML construction and parsing, and upstream
error classification. Tests use the fixture adapter through the same retrieval
logic.

Runtime dependencies:

- Pydantic for validated public result models
- curl-cffi for the production transport and browser impersonation
- Python standard-library `logging`; the package installs no handlers and
  never logs raw response bodies

Development and packaging tools:

- uv for dependency locking, environments, builds, and publishing
- Ruff for formatting and linting
- ty for static checking, pinned exactly while its compatibility is pre-stable
- pytest for deterministic behavior and contract tests

Browser impersonation stays an implementation detail. Normal CI uses captured
responses; a scheduled or manually triggered smoke test detects KIS-NET or
fingerprint changes without making pull requests depend on the live source.

## Shared source contract

`contracts/kisnet` owns representative init, matrix, unavailable-data,
malformed-response, and missing-value fixtures. Node and Python tests must
exercise the same cases and preserve these shared semantics:

- base-date and 종류 request mapping
- canonical tenor order
- `-` and empty-cell handling
- exact and previous-available date resolution
- distinction between unavailable data, transport failure, nonzero protocol
  status, and malformed source data

Semantic parity does not require identical JavaScript and Python object shapes
or field casing. Each package should remain idiomatic for its language.

## Lockstep releases

Release Please remains the only version authority. Configure `packages/node`
and `packages/python` as components in one linked-version group so a releasable
change to either package advances both to the same version. Use one combined
release PR and component-prefixed tags, such as `node-vX.Y.Z` and
`python-vX.Y.Z`, to avoid tag collisions.

After the release PR merges, Release Please creates both component tags. Those
tags trigger registry workflows that publish both packages even when only one
package's implementation changed. This is an accepted cost of presenting the
Node and Python packages as two interfaces to one product.

The existing unprefixed tags remain historical. The current flow uses
component-prefixed tags for both packages.

Publishing targets:

- npm: `@sjunepark/ytm`
- PyPI: `kisnet-ytm`, using trusted publishing without a long-lived token

## Validation gates

Every pull request runs:

- the existing Node build, tool-surface validation, and npm pack dry run
- Ruff formatting and lint checks
- ty against `packages/python`
- Python tests across the supported-version matrix
- Python wheel and source-distribution builds
- installation and `import kisnet_ytm` from the built wheel in a clean
  environment
- shared contract fixtures in both implementations

Live KIS-NET smoke validation is scheduled or manual rather than a merge gate.
Before publishing, confirm that curl-cffi supplies wheels for every advertised
Python and operating-system target.

## Implementation sequence

1. [x] Add shared KIS-NET fixtures and characterize the existing Node behavior.
2. [x] Move the npm package to `packages/node` without changing its published
   interface, output, or validation behavior.
3. [x] Add `packages/python`, its public models and errors, and package-build
   validation.
4. [x] Implement the private Nexacro source seam, curl-cffi adapter, retrieval
   flow, fallback behavior, and logging.
5. [x] Add cross-language contract tests, Python CI, scheduled network smoke
   validation, and clean-wheel installation tests.
6. [x] Configure linked Release Please components and OIDC PyPI publishing;
   document the administrator-owned trusted-publisher configuration.
7. [x] Update the root README, package READMEs, source specification, and agent
   skill to describe shipped behavior, then run a final review of both public
   interfaces.

## Progress log

- 2026-07-16: Added versioned shared Nexacro fixtures and Node contract tests.
  `bun run test`, `npm pack --dry-run`, and `git diff --check` pass. Source
  transport and format failures are now distinct from confirmed unavailable
  data, so previous-date fallback cannot hide upstream breakage. Next: package
  the unchanged Node surface under `packages/node`.
- 2026-07-16: Converted the root to a private Bun workspace, moved the npm
  package to `packages/node`, and added the root `bun.lock`. Frozen install,
  root-delegated Node tests, npm pack dry-run, and artifact inspection pass.
  The package still contains the same eight published paths; package-owned
  docs avoid coupling npm contents to the cross-language root docs. Next: add
  the native Python package and build validation.
- 2026-07-16: Added and locked the native Python package, including public
  models/errors, curl-cffi transport, Nexacro parser, source-independent
  retrieval, and shared fixture tests. Ruff, ty 0.0.60, tests on Python
  3.11-3.14, sdist/wheel builds, a clean 3.11 wheel import, root Node+Python
  validation, and npm pack inspection pass. CI now runs the same deterministic
  gates. Next: scheduled/manual smoke validation and lockstep release wiring.
- 2026-07-16: Added weekday and manual live-source smoke jobs for both public
  surfaces. A local live run resolved `2026-07-16` exactly and returned three
  국채 rows through both Node and Python, confirming the curl-cffi fingerprint
  and parser against the current source. The smoke remains outside PR gates.
  Next: linked Release Please and registry-specific publishing workflows.
- 2026-07-16: Added linked Node and Python Release Please components at the
  historical `0.1.1` baseline, package-local changelogs, component-tag npm and
  PyPI workflows, OIDC environment gates, version/lock/workflow assertions,
  and shared-contract attribution hashes. Frozen installs, all deterministic
  package gates, workflow YAML parsing, the official Release Please schema,
  and uv's no-publish artifact check pass. At that checkpoint no release
  version had been selected, and no external publisher, PR, tag, or registry
  state was changed. Next: shipped documentation and a final public-interface
  review.
- 2026-07-16: Updated the product contract, both package READMEs, the published
  Node specification, and the repository skill for the shipped two-language
  surfaces. Full validation, local link checks, skill discovery, npm pack
  inspection, and a clean Python 3.11 wheel import pass. Final review found no
  safe-fix defects and one public-contract decision: Python currently accepts
  an unbounded `previous_available_days`, unlike Node's 31-day maximum, so an
  extreme value can exhaust resources or raise an untyped date overflow.
  Next: confirm whether to adopt the 31-day Python cap and boundary tests.
- 2026-07-17: Adopted the approved Python fallback contract of `None` or
  `0..31`, completed a package-wide robustness review, and made Nexacro status
  handling fail closed across Node and Python. Negative errors and positive
  warnings now use a distinct protocol error with preserved source status;
  malformed status text remains a format error, and fallback cannot hide either
  case. Request dates are platform-stable, XML encoding follows the payload
  declaration, numeric source text uses the shared grammar, resolution models
  reject impossible histories, extracted source archives rebuild recursively,
  and both registry workflows pin downstream jobs to one immutable release
  commit. Next: external publisher setup, explicit `0.2.0` approval, and any
  release action.
- 2026-07-17: Audited the first lockstep release without changing external
  state. Full documented local validation and the latest `main` CI pass; the
  linked breaking input still resolves to `0.2.0`, npm has only `0.1.0` and
  `0.1.1`, and `kisnet-ytm` is not published on PyPI. GitHub has the release
  token secret metadata but lacks both publishing environments and `main`
  protection; registry-side trusted publisher settings require administrator
  confirmation. Next: obtain explicit approval of both `0.2.0` targets, finish
  those prerequisites, and dispatch Release Please.
- 2026-07-17: Received explicit approval for both `0.2.0` targets, completed
  both trusted publisher identities and GitHub environments, and protected
  `main` with all seven CI checks. Enabled and dispatched Release Please; run
  `29564062227` created combined PR #5 with exact lockstep versions. Its full CI
  and independent release review pass with only non-blocking first-tag compare
  links and a pre-existing duplicate Python changelog heading. No environment
  approval rule will pause publication after merge. Next: obtain explicit
  authorization to merge PR #5 and both `0.2.0` releases.
- 2026-07-17: Received exact merge authorization and merged PR #5 with a merge
  commit that preserved the reviewed Release Please commit. Both component
  tags and GitHub Releases resolve to `f2c25e0`; the npm and PyPI workflows,
  post-merge CI, independent artifact-hash comparisons, and isolated registry
  installs all pass. The first lockstep release is complete.

## Non-goals

- Calling the Node CLI or toolset from Python
- A public generic transport or provider plugin system
- A public async client or batch-fetching interface
- Caching or persistence
- Identical serialized object shapes across languages
- Live external requests in ordinary pull-request validation
