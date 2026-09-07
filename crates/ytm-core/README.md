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
set `HistoryInput.fallback` for bounded previous-available resolution. The
[history contract](../../SPEC.md#multi-date-history) defines the 2,000-date
bound, all-category coverage, and available/unavailable result entries.

Ordinary `history`, `kinds`, and `matrix` calls create their own cancellation scope. Node
and other advanced adapters can use the explicitly named
`*_with_cancellation` methods and `with_transport` injection seam.

The default `YtmClient` uses Reqwest's asynchronous client and must run inside
a Tokio runtime. Custom `Transport` implementations own their runtime behavior
and equivalent deadline, redirect, proxy, retry, and cancellation policy.

The crate is not published by this repository workflow; consumers currently
use a Git or path dependency.
