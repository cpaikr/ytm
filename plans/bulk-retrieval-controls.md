# Bulk retrieval controls and visibility

## Outcome

CLI, Rust, Node, and Python callers can observe long retrievals, tune bounded
retries, and optionally pace HTTP requests without changing selected data or
today's default request behavior. This is the accepted target requested on
2026-09-10; implementation, offline validation and review are complete.
PR delivery is pending; no release has been published.

## Current state

- Core, CLI, Node, and Python sync/async expose bounded retry/pacing controls,
  metadata-only pull progress, and final retrieval statistics. Shared semantics
  and Rust source migration are documented in [SPEC](../SPEC.md#bounded-retrieval-recovery).
- Synthetic HTTP acceptance passed: 250 scanned dates, 180 complete qualifying
  dates, 1,704 attempts including 14 retries. Selected values and ordered requests
  match the unpaced 1,690-attempt baseline. No live throughput claim is implied.
- Complete `bun run validate` passed with CPython 3.12 on macOS ARM64, including
  installed fixture/release wheels, public CLI/Node/Python acceptance, Rust
  consumers, dependency policy, and packaging. Windows guide execution was
  skipped because PowerShell is unavailable; its separate consumer task remains.
- Independent bounded review found one Python close/completion statistics race;
  it is fixed with a regression test. Final counters also survive CLI cancellation
  and export errors. Affected tests and lint checks passed. Documentation and
  local links are reconciled. PR review, CI and merge remain.
- [Recorded live acceptance](../docs/history-retrieval-live-acceptance.md)
  remains separate historical evidence; this goal includes no additional live run.

## Target behavior

### Shared retry and pacing policy

Extend the existing core retrieval-options/context seam; adapters only validate
and translate their public representations. Retain existing timeout constructors
and ordinary call behavior where practical. Inspect public consumers before
changing Rust source contracts and document unavoidable migration explicitly.

- Expose maximum retries (default 2; allow 0; bounded to at most 10), base
  backoff (default 500 ms), maximum backoff (default 1,000 ms), and minimum
  request interval (default 0, disabled). Use explicit millisecond names at CLI
  and language boundaries where durations are numeric. Retain existing timeout
  option names and units. Reject invalid types, negative values, nonfinite or
  unrepresentable durations, and maximum backoff below base before source I/O.
- Use capped exponential full jitter with overflow-safe arithmetic. Permit
  zero backoff deliberately. Existing two default retries retain their current
  timing distribution. Valid provider guidance remains a lower bound even when
  it exceeds the configured backoff maximum; a deadline never resets.
- Apply pacing in the core to physical HTTP attempt start times across every
  lookup and retry in one invocation. The first attempt has no artificial wait.
  The next start respects the latest of pacing, jitter, and provider guidance;
  do not add overlapping waits together or sleep after the last attempt.
  Pacing waits are cancellable and consume the same retrieval budget.
- Pacing is invocation-local, not a provider-wide quota or cross-process rate
  limiter. Document this limit when callers launch multiple operations. Keep
  retrieval sequential. Custom transports retain ownership of their attempt
  policy; never apply an additional service retry loop or invent their stats.
- Keep the retryable status/failure allowlist, exact replay, source identity,
  parser/body bounds, unavailable-data semantics, and all-or-error publication.

### Progress and statistics

Expose optional metadata-only progress and a final retrieval summary through
each public surface. Use one core owner for counter and timing semantics.

- Report scanned calendar dates, completed qualifying dates for count history,
  physical attempts, retries, elapsed retrieval time, and actual waiting time.
  Define retry/pacing wait accounting without double counting overlapping waits.
  A qualifying date is completed only after all its categories are handled.
- Successful calls must expose final statistics without requiring progress to
  be enabled. Failure/cancellation must preserve completed counters and the
  original error identity; no partial dataset is published as success.
- New detailed CLI progress is opt-in and goes to stderr; preserve existing
  automatic terminal history progress and nonterminal silence by default.
  Integrate both with the core counters instead of duplicating tracking.
  Preserve exactly one machine result on stdout and protected exports.
  Make final statistics available in structured output and document text/export
  behavior. SDKs expose opt-in progress plus final statistics using idiomatic
  public APIs, including Python sync and async clients.
- Callbacks/event delivery must be bounded and safe for cancellation, client
  reuse, adapter threading and runtime lifetimes. Choose and document explicit
  observer-error behavior; never silently swallow callback failures, misclassify
  them as transient source errors, or let them trigger HTTP replay. No unbounded
  event queues or detached delivery surviving operation completion.
- Events and summaries contain no provider response bodies or normalized
  yields. Unknown physical-attempt counts for custom transports are explicit,
  not fabricated. Statistics describe retrieval scope, excluding existing
  adapter/export phases outside that budget.

## Implementation and acceptance

1. Define validated core options, statistics/event semantics, and minimal public
   adapter contracts. Preserve the existing core as policy owner; do not add
   parallel transport implementations or persistent job machinery.
2. Implement retry configuration and pacing with deterministic timing tests and
   loopback HTTP tests. Cover default equivalence; zero retries; exhaustion;
   caps/overflow; both `Retry-After` forms; guidance above the cap; overlapping
   pacing/backoff; timeout/cancellation during every wait; terminal failures;
   exact failed-lookup replay; and no wait after completion.
3. Implement progress and summary propagation through Rust, CLI, Node, and
   Python sync/async. Verify exact counters on success, transient recovery,
   failure and cancellation, chronological completion, observer failures,
   multiple invocations, bounded event delivery, and custom-transport semantics.
4. Run a synthetic 180-qualifying-date workload with missing dates/categories,
   injected transient failures, and pacing through the real HTTP transport.
   Assert unchanged selected values/order, complete day boundaries, expected
   request/retry counts, progress monotonicity, and deadline compliance. Use
   virtual time where appropriate; do not make runtime assertions against the
   recorded live latency. Exercise public CLI and SDK option/output contracts
   with the existing judge infrastructure and consumer tests.
5. Run relevant repository validation, Rust formatting/lints/tests, native
   adapter builds, Node/Python validation and public-surface checks required by
   the contribution workflow. Review shared behavior with an independent
   bounded code-review pass; fix actionable findings and harmonize affected docs.

Acceptance requires all three public enhancements on every surface, preserved
default behavior and data contracts, successful targeted and required checks,
review resolution, and accurate documentation. Update the fixed-policy wire
profile in `contracts/kisnet/openapi.yaml` and its schema, validators and
conformance checks together to distinguish defaults from configurable limits.
Update SPEC and ARCHITECTURE for shared semantics, CLI help and SDK
READMEs/types/examples for usage, and
capacity/operational guidance only where verified evidence changes their claims.
Reconcile the old completed retry plan's no-pacing boundary as historical;
this accepted optional pacing target supersedes it without making pacing a
mandatory default or resolving provider operating limits.

## Delivery boundary

Use the fewest cohesive sequential PRs, with initial CodeRabbit review and
feedback resolution through merge under the goal's delivery lifecycle. Retain
individual commits. Release publication is the next separate milestone. Do not
add concurrency, checkpoint/resume, category filtering, provider switching,
quota discovery, or new live bulk runs to implement this outcome.

## Next action

Create the single connected implementation PR against
`codex/bulk-controls-integration`, request the initial CodeRabbit review, resolve
feedback, and merge through the goal's delivery lifecycle.
