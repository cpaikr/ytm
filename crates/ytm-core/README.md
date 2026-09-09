# ytm-core

`ytm-core` is the Rust SDK and sole KIS-NET protocol implementation for this
repository. It owns bounded HTTP transport, Nexacro parsing, kind resolution,
date fallback, all-category history orchestration, normalization, source metadata, and structured errors.

```rust
use ytm_core::{KindsInput, YtmClient};

# async fn run() -> Result<(), ytm_core::YtmError> {
let client = YtmClient::new()?;
let result = client.kinds(KindsInput::default()).await?;
assert!(result.kinds.iter().any(|kind| kind.code == "80"));
# Ok(())
# }
```

Use `DateSelection::dates(Vec<BaseDate>)` or `DateSelection::range(start, end)`
to construct a validated selection, then call
`client.history(HistoryInput::new(selection)).await`. The default is exact;
set `HistoryInput.fallback` for bounded previous-available resolution of fixed dates.
`HistoryInput::new(CountSelection::new(180, end, None)?)` requests the latest
180 dates containing numeric yields. Count mode requires exact fallback,
allows an optional inclusive start, and reports `insufficient_history` when
its bounded search cannot meet the count. `DateSelection::as_dates()` remains
available only for fixed dates; `HistorySelection` distinguishes the two forms. The
[history contract](../../SPEC.md#multi-date-history) defines the 2,000-date
bound, all-category coverage, and available/unavailable result entries.

Ordinary `history`, `kinds`, and `matrix` calls use a shared finite retrieval
budget (30 minutes by default). Override it with
`RetrievalOptions::new(std::time::Duration::from_secs(3600))?` and
`client.history_with_options(input, options).await`. Each operation also exposes
`*_with_options_and_cancellation(input, options, token)`; existing
`*_with_cancellation` calls retain their defaults. The
[recovery contract](../../SPEC.md#bounded-retrieval-recovery) owns attempt policy,
timeout scope, error metadata, and compatibility changes.

The default `YtmClient` uses Reqwest's asynchronous client inside Tokio. Custom
`Transport` implementations keep the required `post` method and own runtime and
retry behavior. The service enforces the outer asynchronous deadline. Decorators
must forward the defaulted `post_with_context` hook so the inner HTTP client
receives the same budget. Source identity and body/parser bounds still apply.

`ErrorDetails` now has optional `retry` metadata. This breaks external exhaustive
struct literals/destructuring: add `retry: None`, bind the field or use `..`.
Existing constructors continue to work. This requires source-breaking version
and migration handling in the next authorized release, not a compatible patch.

The crate is not published by this repository workflow; consumers currently
use a Git or path dependency.
