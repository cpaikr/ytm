//! Bounded, pull-based observation. No caller code runs inside retrieval.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

use crate::YtmError;

/// Metadata for one invocation; physical counts are unknown for custom transports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalStatistics {
    pub scanned_date_count: usize,
    pub completed_qualifying_date_count: usize,
    pub discovery_count: usize,
    pub matrix_lookup_count: usize,
    pub physical_attempt_count: Option<u64>,
    pub retry_count: Option<u64>,
    pub elapsed_ms: u64,
    /// Actual wall time in combined retry/pacing waits, counted once.
    pub waiting_ms: u64,
    pub finished: bool,
}

#[derive(Debug, Default)]
struct State {
    started: Option<Instant>,
    statistics: RetrievalStatistics,
    waiting: Duration,
    wait_started: Option<Instant>,
}

/// Single-use progress handle. Snapshots coalesce intermediate updates, use
/// constant memory, and remain readable after success, failure, or cancellation.
/// Attach a fresh handle to each invocation; reusing one is an input error.
#[derive(Debug, Clone, Default)]
pub struct RetrievalProgress(Arc<Mutex<State>>);

impl RetrievalProgress {
    pub fn new() -> Self {
        Self::default()
    }

    /// None until retrieval starts. This getter never runs a user callback.
    pub fn snapshot(&self) -> Option<RetrievalStatistics> {
        let state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let started = state.started?;
        let mut statistics = state.statistics.clone();
        if !statistics.finished {
            statistics.elapsed_ms = millis(started.elapsed());
            statistics.waiting_ms = millis(
                state.waiting
                    + state
                        .wait_started
                        .map_or(Duration::ZERO, |start| start.elapsed()),
            );
        }
        Some(statistics)
    }

    pub(crate) fn start(&self) -> Result<(), YtmError> {
        let mut state = self.0.lock().map_err(|_| YtmError::defect())?;
        if state.started.is_some() {
            return Err(YtmError::invalid_parameter(
                "retrieval",
                "progress",
                "A progress handle can be attached to only one invocation.",
                serde_json::Value::Null,
            ));
        }
        state.started = Some(Instant::now());
        state.statistics.physical_attempt_count = Some(0);
        state.statistics.retry_count = Some(0);
        Ok(())
    }

    pub(crate) fn update(
        &self,
        update: impl FnOnce(&mut RetrievalStatistics),
    ) -> Result<(), YtmError> {
        let mut state = self.0.lock().map_err(|_| YtmError::defect())?;
        if !state.statistics.finished {
            update(&mut state.statistics);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn is_waiting(&self) -> bool {
        self.0.lock().unwrap().wait_started.is_some()
    }

    pub(crate) fn wait(&self) -> WaitGuard {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .wait_started = Some(Instant::now());
        WaitGuard(self.clone())
    }

    pub(crate) fn finish(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.statistics.finished {
            return;
        }
        if let Some(start) = state.wait_started.take() {
            state.waiting += start.elapsed();
        }
        state.statistics.waiting_ms = millis(state.waiting);
        state.statistics.elapsed_ms = state.started.map_or(0, |start| millis(start.elapsed()));
        state.statistics.finished = true;
    }
}

pub(crate) struct WaitGuard(RetrievalProgress);
impl Drop for WaitGuard {
    fn drop(&mut self) {
        let mut state = self.0 .0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(start) = state.wait_started.take() {
            state.waiting += start.elapsed();
        }
    }
}

// Context clones own this guard, whereas public progress handles do not. Dropping
// an async operation therefore freezes its final metadata even without a result.
#[derive(Debug)]
pub(crate) struct CompletionGuard(pub RetrievalProgress);
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        self.0.finish();
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CancellationToken, KindsInput, PreparedRequest, RetrievalOptions, Transport, YtmService,
    };

    #[tokio::test]
    async fn single_use_handles_are_rejected_without_changing_completed_statistics() {
        let service = YtmService::new().unwrap();
        let progress = RetrievalProgress::new();
        assert_eq!(progress.snapshot(), None);
        let options = RetrievalOptions::default().with_progress(progress.clone());
        let first = service
            .kinds_with_options(KindsInput::default(), options.clone())
            .await
            .unwrap();
        let stats = first.statistics.unwrap();
        assert_eq!(stats.physical_attempt_count, Some(0));
        assert_eq!(stats.scanned_date_count, 0);
        assert!(stats.finished);
        let error = service
            .kinds_with_options(KindsInput::default(), options)
            .await
            .unwrap_err();
        assert_eq!(error.details.code, "invalid_parameter");
        assert_eq!(error.details.parameter.as_deref(), Some("progress"));
        assert_eq!(progress.snapshot().unwrap(), stats);
        let next = service
            .kinds(KindsInput::default())
            .await
            .unwrap()
            .statistics
            .unwrap();
        assert_eq!(next.physical_attempt_count, Some(0));
        assert!(next.finished);
    }

    struct CustomTransport;
    #[async_trait::async_trait]
    impl Transport for CustomTransport {
        async fn post(
            &self,
            _: PreparedRequest,
            _: CancellationToken,
        ) -> Result<Vec<u8>, YtmError> {
            Err(YtmError::transport("custom failure", Some(503), None))
        }
    }

    #[tokio::test]
    async fn custom_transports_keep_policy_ownership_and_explicit_unknown_counts() {
        let progress = RetrievalProgress::new();
        let policy = RetrievalOptions::default()
            .with_request_policy(10, Duration::ZERO, Duration::ZERO, Duration::from_secs(30))
            .unwrap()
            .with_progress(progress.clone());
        let error = YtmService::with_transport(CustomTransport)
            .kinds_with_options(KindsInput::for_date("2026-06-09".parse().unwrap()), policy)
            .await
            .unwrap_err();
        assert_eq!(error.details.reason, "custom failure");
        assert!(error.details.retry.is_none());
        let stats = error.details.statistics.unwrap();
        assert_eq!(stats.scanned_date_count, 1);
        assert_eq!(stats.discovery_count, 1);
        assert_eq!(stats.physical_attempt_count, None);
        assert_eq!(stats.retry_count, None);
        assert_eq!(stats.waiting_ms, 0);
        assert_eq!(stats, progress.snapshot().unwrap());
    }
}
