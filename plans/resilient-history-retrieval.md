# Resilient historical retrieval

## Outcome

Implement [issue #45](https://github.com/cpaikr/ytm/issues/45): a transient
failure of a KIS-NET lookup can recover within bounded attempts and one overall
retrieval deadline, without changing requested dates, category identities,
selected observations, yields, source identity, or all-or-error publication.
Rust, CLI, Node, and Python use the same core policy.

Implementation through offline acceptance was delivered under the completed
[goal contract](../goals/resilient-history-retrieval-offline.md). Full live
acceptance and release publication remain separate, pending stages.

## Current state

Offline implementation is complete and merged through
[PR #46](https://github.com/cpaikr/ytm/pull/46), merge `f6056a4`.
Implementation `11d534f` and validation follow-up `51bfca4` are preserved.

- Real-HTTP recovery replays only the failed lookup and matches the baseline
  result and request sequence. Core and public CLI/Node/Python checks cover
  deadlines, cancellation, source errors, client reuse and protected exports.
- Every local gate stage and [required platform CI](https://github.com/cpaikr/ytm/actions/runs/34345673007)
  passed. Windows acceptance passed after correcting a platform-specific
  overflow assumption in the test harness. Independent reviews, Codex review,
  CodeRabbit feedback resolution and documentation reconciliation are complete.
- Full 180-observation live acceptance remains pending and unstarted. Issue #45
  stays open. No provider throughput or release publication claim is made.

## Next action

Await separate authorization for the bounded live acceptance milestone below.
It is queued project work, outside the completed offline goal. Release
publication remains separately authorized.

## Target behavior and decisions

The implemented policy is owned by [SPEC.md](../SPEC.md#bounded-retrieval-recovery):
exact replay eligibility, attempts and waits, one retrieval deadline, error
metadata, and compatibility. [ARCHITECTURE.md](../ARCHITECTURE.md) owns the
service/transport boundary and custom-transport hook. Interface references own
their option syntax. The validation matrix below retains the acceptance
obligations without a second copy of the policy.

The three-attempt limit, jitter caps, and 30-minute default are engineering
choices, not measured provider limits. Live acceptance must record elapsed time
before treating the default as operationally validated. Typed pinned dependency
errors distinguish interrupted HTTP bodies from corrupt decompression; unknown
failures stay terminal. Context7 lacked the precise pinned error coverage, so
official crate source supplied the classification evidence.

Preserve exact-date selection, previous-available fallback, canonical/discovered
categories, numeric count qualification, unique ordered observations, source
identity, sequential requests, strict parser/body bounds, no redirects/proxies,
and protected export publication. Existing Transport implementations retain
their required method; the narrow Rust ErrorDetails source migration and finite
default timeout are explicit [compatibility changes](../SPEC.md#compatibility)
that the next authorized release must account for.

No ordinary-request pacing is added without measured timing/status evidence.
No alternate provider, category filtering, persistent checkpoint/cache,
parallel retrieval, synthetic replacement data, downstream estimator changes,
or redistribution work is included. The existing
[provider enablement task](../tasks/resolve-production-provider-enablement.md)
owns production rights and operating qualification.

## Implementation sequence

### Reproduce the failure through the real HTTP path

- [x] Build a deterministic loopback server sequence with valid synthetic
  Nexacro initialization/matrix responses for a multi-day, multi-category history.
  Fail a late category transiently, then make its identical replay succeed.
- [x] Drive the public history operation through the production HTTP loop with
  a test-only loopback routing seam. Before the fix, assert the full operation
  fails and capture structured error, request identities, and exact sequence.
- [x] Add initialization-failure and mid-body interruption scenarios. Keep
  fixtures synthetic; do not replay or retain live provider payloads.
- [x] Keep loopback routing private/test-only or under the existing guarded
  judge facility. Release builds must not accept an environment-selected origin.

Exit: a failing observable regression proves the missing recovery; neither the
test transport nor the server implements retries for the client.

### Implement the core mechanism and budget

- [x] Add validated retrieval options, invocation context, cooperative deadline
  checks, and the compatible transport hook; forward context through decorators.
- [x] Implement typed failure classification, exact replay, bounded attempts,
  per-attempt clipping, jitter, `Retry-After`, and cancellable waits/body reads.
- [x] Preserve history caching/selection and enrich final errors with retry
  context. Retain terminal causes when adding date/category/deadline information.
- [x] Use existing Tokio timing facilities and private pure scheduling helpers
  for virtual-time tests. Add a small maintained dependency only if it removes
  durable HTTP-date/randomness complexity; inspect pinned docs, MSRV, and license
  impact first. Preserve Rust 1.92/edition 2021 and current runtime boundaries.

Exit: real-HTTP history recovery passes with byte-identical requests and unchanged
results; all terminal, budget, and cancellation tests below pass offline.

### Project options and errors through supported interfaces

- [x] Add the single timeout option to CLI, Node request options, Python
  sync/async keyword arguments, native bindings, and public Rust options.
- [x] Preserve old call forms and validation ordering; test shape errors without
  network access, custom transport compatibility, and option/default parity.
- [x] Carry optional retry details through adapter envelopes and exception
  mappings; document and test the explicit Rust `ErrorDetails` literal migration
  while preserving constructors. Keep caller abort/close behavior and
  post-cancellation client reuse.
- [x] Exercise actual CLI output/exit and export protection after retry exhaustion
  and operation timeout, including an existing destination with overwrite set.

Exit: supported interfaces expose equivalent retrieval policy and distinguish
timeout, cancellation, terminal source error, and genuine unavailable data.

### Align contracts and complete offline validation

- [x] Update wire-profile retry policy and its schema/validators/conformance
  assertions together. Preserve authority for origin, POST bodies, response
  validation, body/depth limits, redirects, and sequential execution.
- [x] Update `SPEC.md` as the owner of retry/deadline/error behavior;
  `ARCHITECTURE.md` for ownership/custom transports; core/Node/Python references
  and CLI help for their options; provider policy for the bounded recovery
  change. Link to canonical rules instead of duplicating policy tables.
- [x] Document the new 30-minute default as an intentional compatibility change
  for slow calls, the override, and the separation of retrieval from queue/export
  time. Keep historical evidence and provider qualification status truthful.
- [x] Run targeted tests first, then the complete repository gate once after
  integration. Run one bounded independent `$code-review` pass for the shared
  behavior and `$harmonize-docs changes`; address material findings and rerun
  only affected checks unless new uncertainty warrants more.

Exit: offline implementation is complete and reviewable; live acceptance remains
explicitly pending until its own evidence exists.

### Record bounded live acceptance separately

- [ ] Confirm provider access is suitable under the existing operating boundary;
  do not infer bulk/live authorization from this planning request or synthetic
  success. Resolve any remaining owner condition before the long run.
- [ ] Perform one bounded run of
  `ytm history --end-date 2023-06-30 --count 180 --format json` using an identified
  candidate binary and the documented deadline. Prefer Windows x64/PowerShell 7
  to match the incident; distinguish another host's evidence explicitly.
- [ ] Stream output into an in-memory acceptance checker. Check 180 unique
  ascending selected dates, end-date bounds, complete category processing,
  unchanged source identity, and numeric-date qualification. Do not write raw
  responses, rows, yields, or all-category JSON into the evidence record.
- [ ] Record commit, version, binary hash, platform, start/end/duration, selected
  and scanned counts, configured limits, and sanitized failure/retry context
  where available. Silent successful retries need no new public telemetry API;
  deterministic tests establish replay correctness.
- [ ] On provider failure, record the terminal context and leave full live
  acceptance incomplete. Do not automatically repeat the long run, loosen data
  rules, or substitute a short smoke as acceptance evidence.

Exit: record either full reproduction success or an explicit remaining live
blocker. A downstream live-to-frozen comparison requires the downstream owner
and remains distinct from this repository's retrieval acceptance. Installation,
publication, and release tagging follow separate authorization and the existing
[release runbook](../docs/release.md); this plan does not start them automatically.

## Validation matrix

| Requirement | Evidence required |
| --- | --- |
| Exact recovery and completed-prefix reuse | Real HTTP history sequence: late failure then success; compare dates, kinds, source identity, row/yield values and ordering against the no-failure fixture; assert exact physical request sequence. |
| Discovery and body recovery | Initialization failure and interrupted response body both replay only their own lookup; no partial body bytes leak into the successful parse. |
| Eligibility | Cover each allowlisted HTTP status, 404 and representative terminal statuses, timeout, recognized I/O faults, unclassified errors, invalid media/body/XML/protocol, cancellation, and unavailable data. |
| Attempts and backoff | Exhaustion yields exactly three attempts and no trailing sleep; fixed random samples prove both jitter bounds and schedule progression without real long sleeps. |
| Provider guidance | Delta/date forms, past/malformed/overflow values, guidance exceeding the deadline, and precedence over jitter. No retry occurs earlier than valid guidance. |
| Overall budget | Shared across successful calls, categories, dates, fallback and retries; a sequence of individually timely responses can still exhaust it. Check expiration during send, body, wait, traversal and before another lookup. |
| Cancellation and lifecycle | Pre-cancelled call makes no request; cancellation during send/body/wait and deadline interaction; no detached retry; Python close drains and subsequent allowed calls remain usable. |
| Structured failure | Date/category, operation, terminal status/cause, attempt count and stop reason survive projections; distinguish physical attempts from fallback dates. |
| Data invariants | Existing fixed-date/fallback/count tests remain valid, including a fatal late-category error on the otherwise qualifying final day, unavailable weekends, and no duplicate observations. |
| Public surfaces | Existing Rust custom transport, constructor-based error usage, and old call forms compile; updated error literals demonstrate the documented source migration. Node/Python options validate before I/O; defaults match; timeout and cancellation map consistently. |
| CLI integrity | One valid JSON envelope, expected failure exit, bounded terminal-only progress, no new sensitive diagnostic fields, unchanged destination/no staging residue after exhaustion or timeout. |
| Scale without provider load | Synthetic count-180 success and 2,000-date exhaustion retain expected logical request/selection bounds; retries add only deliberately injected physical attempts. |
| Full live acceptance | One identified candidate completes the issue's 180-observation command under the documented budget, or the plan explicitly records it as incomplete. |

Use focused core/CLI/adapter tests while editing. Relevant existing entry points:

```sh
cargo test --locked -p ytm-core
cargo test --locked -p ytm-cli
bun run contracts:check
bun run rust:consumer:check
bun run validate:node
bun run validate:python
bun run test:surfaces
bun run validate
```

The final `bun run validate` delegates to the repository-owned gate; do not
duplicate an entire passing gate without a new change or failure. Select a
supported Python interpreter when needed, as existing validation requires.
Test-only clock/server additions must stay out of release configuration.

## Completion tracking

Keep offline implementation, full live acceptance, and release publication as
separate states. Close the implementation work only after its contracts, tests,
bounded review, and documentation reconciliation pass. Issue #45's full
acceptance remains incomplete if its long live reproduction has not succeeded.
Update this item's current state and next action with concise evidence; remove
its active roadmap link only when the included outcome is complete.
