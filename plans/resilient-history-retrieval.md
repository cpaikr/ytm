# Resilient historical retrieval

## Outcome

Implement [issue #45](https://github.com/cpaikr/ytm/issues/45): a transient
failure of a KIS-NET lookup can recover within bounded attempts and one overall
retrieval deadline, without changing requested dates, category identities,
selected observations, yields, source identity, or all-or-error publication.
Rust, CLI, Node, and Python use the same core policy.

This is an implementation plan, not a claim of delivered behavior. The current
request authorizes planning only. Implementation, live acceptance, and release
delivery remain distinct execution stages.

## Current state

Assessed at `e9360c9` on 2026-09-09; the working tree was clean before planning.

- [HttpTransport](../crates/ytm-core/src/transport.rs) performs one attempt,
  disables Reqwest retries, and applies a 20-second deadline through body
  consumption. Cancellation interrupts request execution and body reads.
- [History orchestration](../crates/ytm-core/src/service.rs) aborts on operational
  errors and caches only confirmed observations or unavailable data. Count
  selection qualifies complete dates across all categories. Preserve this logic.
- There is no overall retrieval deadline. The existing date/count bounds limit
  traversal, not elapsed time. [Capacity evidence](../docs/history-capacity.md)
  records 1,620 requests for the synthetic 180-date success case and 18,000 for
  the synthetic 2,000-date exhaustion case; neither measures live throughput.
- [ErrorDetails](../crates/ytm-core/src/error.rs) lacks physical attempt metadata.
  Its broad public `retryable` hint is unsuitable as an automatic retry classifier.
  History already retains date/category context and nests source `actual`.
- Zero retries is an explicit [wire-profile policy](../contracts/kisnet/openapi.yaml),
  asserted in [request conformance tests](../crates/ytm-core/src/request.rs), and
  repeated in architecture and provider operating policy.
- Existing core, adapter, and CLI lifecycle tests cover selection, cancellation,
  fatal errors, and protected exports. The judge's replacement `Transport`
  bypasses real HTTP behavior and cannot alone prove HTTP retry recovery.
- Issue #45 supplies intermittent Windows failure evidence, including later
  recovery of some exact requests. No new live reproduction has been performed.
  The cause of the intermittent failures and the isolated 404 remain unproven.
- No implementation checklist item below is complete. Existing goal files are
  completed historical records; this plan does not create or reactivate a goal.

## Next action

When implementation is requested, begin with the synthetic full-history failure
reproduction below and record its failing structured error and request sequence.
Then implement the shared deadline context and HTTP retry loop against that test.

## Target behavior and decisions

### Retry only a replayable physical lookup

Use one explicit loop in the core HTTP transport, below Nexacro parsing and
history selection. Both dated initialization and matrix retrieval participate.
Confirm from the wire operations and request construction that these POSTs are
read-only lookups; restrict automatic replay to those supported operations.
Do not infer replay safety from the POST method or an arbitrary injected URL.

Each attempt reuses the exact prepared URL, headers, operation, date/category,
and body. Retry neither a whole day nor the traversal prefix. Drop a failed
attempt's partial body before replay; only a complete, validated response can
reach parsing and become an observation.

Keep Reqwest's built-in retries disabled so physical attempts have one owner.
Classify the typed transport failure before projecting it to `YtmError`:

| Outcome | Planned handling |
| --- | --- |
| Request timeout; identified transient connection or interrupted-body I/O failure | Retry the same lookup within limits. |
| HTTP 408, 429, 500, 502, 503, 504 | Retry within limits; apply valid `Retry-After` where supplied. |
| HTTP 404 and other non-allowlisted statuses, including redirects | Return the existing transport failure without automatic replay. |
| TLS certificate/configuration failure, invalid request construction, unclassified dependency error | Fail explicitly; a broad connect/request label does not establish transience. |
| Invalid content type, decompression corruption, body-size overflow, malformed XML, source-format or nonzero protocol status | Preserve the existing terminal error; do not retry. |
| Confirmed unavailable data | Preserve availability/fallback handling; do not treat it as transport recovery. |
| Caller cancellation | Stop promptly with the existing cancellation identity and non-retryable metadata. |

Resolve precise connection/body-error classification against the pinned
Reqwest 0.13.4 implementation and current official documentation during the
first implementation slice. Use Context7 first, then official source/docs if
coverage is insufficient. Do not classify by matching dependency error strings.
Unknown failures remain terminal rather than expanding the allowlist implicitly.

### Attempts, waits, and the overall retrieval deadline

The planned defaults are engineering choices, not measured provider limits:

- Three total attempts per physical lookup: the first attempt plus two retries.
  This permits recovery from isolated failures without repeated escalation.
- Keep the current 20-second per-attempt ceiling, including DNS/TLS, headers,
  and decompressed body consumption. Clip it to the remaining retrieval budget.
- Use exponential full jitter: the first retry delay is sampled from 0–500 ms,
  the second from 0–1,000 ms. These short caps separate immediate repeated
  attempts without adding routine latency to successful requests. Keep the
  sampling source injectable privately for deterministic tests.
- Add a default 30-minute overall retrieval timeout with one caller override.
  This is a finite operational guard for long traversals, not a promise that
  every supported date range fits. Callers can select a larger finite value
  for slower or larger requests. Record elapsed time during live acceptance
  before treating this default as operationally validated.
- Retry counts, status policy, jitter caps, and per-attempt timeout remain core
  defaults. Do not add separate flags for each policy constant.

Start one monotonic deadline after public input validation when the core begins
the invocation. It covers all discovery, matrix calls, fallback/count traversal,
retry waits, body reads, and cooperative parsing/normalization checks. It does
not include Python's pre-dispatch client queue, CLI destination preflight,
adapter serialization, or workbook rendering/publication. Name and document
this as a retrieval timeout; existing cancellation remains effective outside it.
Never reset this deadline for another category, date, or retry.

At request/wait boundaries and existing traversal/normalization stop checks,
check the shared deadline and cancellation. Deadline expiry must stop an
in-flight request or wait, return an explicit failure, and prevent further source
requests. Use an invocation-local cancellation child; expiry must not cancel a
caller's reusable token or poison another call on the same client. Cancellation
already observed when a result is finalized takes precedence over timeout.
Do not promise preemption of arbitrary blocking code in custom transports.

Accept both delta-seconds and HTTP-date forms of `Retry-After`. Convert a date
to a nonnegative duration once using wall-clock time, then wait monotonically.
Use the greater of jitter backoff and valid provider guidance. Ignore malformed
or past guidance in favor of normal backoff; handle numeric/date overflow
without panics or wrapping. If a valid wait leaves no time for another attempt,
fail immediately with the deadline stop reason and preserve the last source
failure. Never shorten valid guidance to retry early, sleep beyond the budget,
or sleep after the last permitted attempt.

### Shared ownership and public compatibility

Keep the core service responsible for the invocation deadline and history
context; keep HTTP eligibility, attempt execution, and backoff in `HttpTransport`.
Use a small concrete execution context carrying deadline and cancellation,
passed explicitly through the internal retrieval path. Avoid task-local or
process-global deadline state and a generic resilience framework.

Preserve existing domain request/result structures and default call forms.
Expose only the overall timeout through execution options:

| Interface | Planned projection |
| --- | --- |
| Rust SDK | A validated duration in retrieval options; existing methods delegate to the same implementation with defaults. Preserve existing cancellation methods. |
| Node SDK | Optional `operationTimeoutMs` beside `signal` in `RequestOptions`. |
| Python sync/async SDK | Optional keyword-only `operation_timeout_seconds` on `kinds`, `matrix`, and `history`. |
| CLI | `--operation-timeout-seconds` on source-retrieval commands; no release-management behavior change. |

Require a positive finite value representable by the core clock. Reject zero,
negative values, overflow, and invalid shapes before any source request. Node
milliseconds must be safe integers; Python/CLI seconds must be positive integers
and Python booleans must be rejected. Defaults are core-owned, with adapter help
and declarations checked for consistency. Do not offer an unlimited setting.

The public `Transport` trait has real injected consumers in tests and SDK use.
Preserve its existing required `post` signature and `PreparedRequest` shape.
Add a default deadline-aware hook that delegates to existing `post`; override it
in `HttpTransport` to pass the remaining budget into its single retry loop.
The service enforces the outer deadline for both paths. Update the CLI progress
decorator to forward the hook/context, so it cannot accidentally reset the
budget. This compatibility hook earns its place by preserving existing custom
implementations; custom transports still own their documented retry behavior.
Direct `HttpTransport::post` calls use the same loop with a default finite scope.
Do not add a second service retry loop around custom transports.

### Errors and diagnostics

Retain existing error codes, terminal source cause/status, operation, and
history date/category context. Add an optional, typed `retry` detail containing
`attemptCount`, `maxAttempts`, `sourceOperation`, and `stopReason` on failures
with HTTP-attempt context. Counts describe attempts of the failing physical
lookup, not observations or aggregate history requests. Keep `attemptedDates`
unchanged. Use explicit stop reasons for terminal failure, attempt exhaustion,
operation deadline, and cancellation; omit retry context when no lookup began.

A deadline reached after a source failure retains that terminal source cause
and records `operation_deadline` separately. Expiry during an active request
without a prior source failure reports a timeout cause. Neither condition may
become unavailable data, insufficient history, or caller cancellation. Public
`retryable` remains a recovery hint for callers, distinct from automatic
eligibility; cancellation remains false. Preserve retry details when service
code enriches errors instead of rebuilding and losing them.

Keep successful result schemas and source metadata unchanged. Project the new
optional error detail through Rust, CLI JSON, Node serialization/types, and
Python exception details. The optional serialized field is additive for JSON,
but adding a public field to the exhaustive Rust `ErrorDetails` struct breaks
external struct literals and exhaustive destructuring. Accept this narrow
Rust source change explicitly: preserve constructor-based usage, initialize
absent metadata in existing constructors, document `retry: None`/destructuring
migration, and verify both old constructor use and updated literal use in the
Rust consumer checks. Do not describe or ship the field addition as a
source-compatible Rust patch; record its version/migration impact in the next
authorized release process. Repository-local searches alone cannot prove the
absence of external literal construction.

Retries are silent by default. Retain the CLI's existing bounded terminal-stderr
progress, counting logical discoveries/fetches. Redirected stderr stays quiet;
stdout remains one parseable result or error. Final structured failures provide
attempt context. No provider bodies, yields, request bodies, credentials, or
dependency error strings are added to diagnostics.

### Scope retained and deferred

Retain exact-date selection, previous-available fallback, canonical/discovered
categories, numeric count qualification, unique ordered observations, source
identity, sequential requests, strict parser/body bounds, no redirects/proxies,
and protected export publication. Retry recovery does not alter these rules.

Evaluate pacing from sanitized timing/status/retry-count evidence collected by
tests and the bounded acceptance run. There was no observed 429 in the incident.
Do not introduce an interval setting or mandatory ordinary-request delay in
this implementation. If evidence supports pacing, record a separate measured
proposal with scope, deadline/cancellation interaction, and acceptance criteria.

No alternate provider, category filtering, checkpoint/cache persistence,
parallel retrieval, synthetic replacement data, downstream estimator changes,
or redistribution work is included. The existing
[provider enablement task](../tasks/resolve-production-provider-enablement.md)
continues to own production rights and operating qualification.

## Implementation sequence

### Reproduce the failure through the real HTTP path

- [ ] Build a deterministic loopback server sequence with valid synthetic
  Nexacro initialization/matrix responses for a multi-day, multi-category history.
  Fail a late category transiently, then make its identical replay succeed.
- [ ] Drive the public history operation through the production HTTP loop with
  a test-only loopback routing seam. Before the fix, assert the full operation
  fails and capture structured error, request identities, and exact sequence.
- [ ] Add initialization-failure and mid-body interruption scenarios. Keep
  fixtures synthetic; do not replay or retain live provider payloads.
- [ ] Keep loopback routing private/test-only or under the existing guarded
  judge facility. Release builds must not accept an environment-selected origin.

Exit: a failing observable regression proves the missing recovery; neither the
test transport nor the server implements retries for the client.

### Implement the core mechanism and budget

- [ ] Add validated retrieval options, invocation context, cooperative deadline
  checks, and the compatible transport hook; forward context through decorators.
- [ ] Implement typed failure classification, exact replay, bounded attempts,
  per-attempt clipping, jitter, `Retry-After`, and cancellable waits/body reads.
- [ ] Preserve history caching/selection and enrich final errors with retry
  context. Retain terminal causes when adding date/category/deadline information.
- [ ] Use existing Tokio timing facilities and private pure scheduling helpers
  for virtual-time tests. Add a small maintained dependency only if it removes
  durable HTTP-date/randomness complexity; inspect pinned docs, MSRV, and license
  impact first. Preserve Rust 1.92/edition 2021 and current runtime boundaries.

Exit: real-HTTP history recovery passes with byte-identical requests and unchanged
results; all terminal, budget, and cancellation tests below pass offline.

### Project options and errors through supported interfaces

- [ ] Add the single timeout option to CLI, Node request options, Python
  sync/async keyword arguments, native bindings, and public Rust options.
- [ ] Preserve old call forms and validation ordering; test shape errors without
  network access, custom transport compatibility, and option/default parity.
- [ ] Carry optional retry details through adapter envelopes and exception
  mappings; document and test the explicit Rust `ErrorDetails` literal migration
  while preserving constructors. Keep caller abort/close behavior and
  post-cancellation client reuse.
- [ ] Exercise actual CLI output/exit and export protection after retry exhaustion
  and operation timeout, including an existing destination with overwrite set.

Exit: supported interfaces expose equivalent retrieval policy and distinguish
timeout, cancellation, terminal source error, and genuine unavailable data.

### Align contracts and complete offline validation

- [ ] Update wire-profile retry policy and its schema/validators/conformance
  assertions together. Preserve authority for origin, POST bodies, response
  validation, body/depth limits, redirects, and sequential execution.
- [ ] Update `SPEC.md` as the owner of retry/deadline/error behavior;
  `ARCHITECTURE.md` for ownership/custom transports; core/Node/Python references
  and CLI help for their options; provider policy for the bounded recovery
  change. Link to canonical rules instead of duplicating policy tables.
- [ ] Document the new 30-minute default as an intentional compatibility change
  for slow calls, the override, and the separation of retrieval from queue/export
  time. Keep historical evidence and provider qualification status truthful.
- [ ] Run targeted tests first, then the complete repository gate once after
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
