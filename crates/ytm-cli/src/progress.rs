//! Interactive-only transport decoration; no source payload is logged.
use async_trait::async_trait;
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use ytm_core::{
    CancellationToken, HttpTransport, PreparedRequest, RetrievalContext, Transport, YtmError,
    YtmService,
};

struct ProgressTransport {
    inner: Arc<dyn Transport>,
    state: Mutex<State>,
}
struct State {
    last: Option<Instant>,
    dates: usize,
    pairs: usize,
}

pub(super) fn service() -> Result<YtmService, YtmError> {
    #[cfg(feature = "judge-fixtures")]
    let inner = match ytm_core::judge::FixtureTransport::from_env()? {
        Some(inner) => inner,
        None => HttpTransport::shared()?,
    };
    #[cfg(not(feature = "judge-fixtures"))]
    let inner = HttpTransport::shared()?;
    Ok(YtmService::with_transport(ProgressTransport {
        inner,
        state: Mutex::new(State {
            last: None,
            dates: 0,
            pairs: 0,
        }),
    }))
}
#[async_trait]
impl Transport for ProgressTransport {
    async fn post(
        &self,
        request: PreparedRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<u8>, YtmError> {
        self.record(&request)?;
        self.inner.post(request, cancellation).await
    }
    async fn post_with_context(
        &self,
        request: PreparedRequest,
        context: RetrievalContext,
    ) -> Result<Vec<u8>, YtmError> {
        self.record(&request)?;
        self.inner.post_with_context(request, context).await
    }
}

impl ProgressTransport {
    fn record(&self, request: &PreparedRequest) -> Result<(), YtmError> {
        {
            let mut state = self.state.lock().map_err(|_| YtmError::defect())?;
            if request.operation == "initializeYtmMatrix" {
                state.dates += 1;
            } else {
                state.pairs += 1;
            }
            if state
                .last
                .is_none_or(|last| last.elapsed() >= Duration::from_secs(2))
            {
                let _ = writeln!(std::io::stderr(), "YTM history: {} dated discoveries, {} date/category fetches started (including fallback).", state.dates, state.pairs);
                state.last = Some(Instant::now());
            }
        }
        Ok(())
    }
}
