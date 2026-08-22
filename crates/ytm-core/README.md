# ytm-core

`ytm-core` is the Rust SDK and sole KIS-NET protocol implementation for this
repository. It owns bounded HTTP transport, Nexacro parsing, kind resolution,
date fallback, normalization, source metadata, and structured errors.

```rust
use ytm_core::{KindsInput, YtmClient};

# async fn run() -> Result<(), ytm_core::YtmError> {
let client = YtmClient::new()?;
let result = client.kinds(KindsInput::default()).await?;
assert!(result.kinds.iter().any(|kind| kind.code == "80"));
# Ok(())
# }
```

Ordinary `kinds` and `matrix` calls create their own cancellation scope. Node
and other advanced adapters can use the explicitly named
`*_with_cancellation` methods and `with_transport` injection seam.

The crate is not published by this repository workflow; consumers currently
use a Git or path dependency.
