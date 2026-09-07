//! Interactive-only transport decoration; no source payload is logged.
use async_trait::async_trait;
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use ytm_core::{
    CancellationToken, HttpTransport, PreparedRequest, Transport, YtmError, YtmService,
};

struct ProgressTransport {
    inner: Arc<dyn Transport>,
    state: Mutex<State>,
}
struct State {
    last: Instant,
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
            last: Instant::now() - Duration::from_secs(2),
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
        {
            let mut state = self.state.lock().map_err(|_| YtmError::defect())?;
            if request.operation == "initializeYtmMatrix" {
                state.dates += 1;
            } else {
                state.pairs += 1;
            }
            if state.last.elapsed() >= Duration::from_secs(2) {
                let _ = writeln!(std::io::stderr(), "YTM history: {} dated discoveries, {} date/category fetches started (including fallback).", state.dates, state.pairs);
                state.last = Instant::now();
            }
        }
        self.inner.post(request, cancellation).await
    }
}
