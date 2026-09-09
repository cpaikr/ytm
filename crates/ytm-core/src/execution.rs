use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::time::Instant;

use crate::{CancellationToken, RetryDetails, RetryStopReason, YtmError};

pub const DEFAULT_OPERATION_TIMEOUT_SECONDS: u64 = 30 * 60;

/// Execution policy independent of domain date/category selection.
#[derive(Debug, Clone, Copy)]
pub struct RetrievalOptions {
    operation_timeout: Duration,
}

impl RetrievalOptions {
    /// Reject zero or durations that cannot be represented by the monotonic clock.
    pub fn new(operation_timeout: Duration) -> Result<Self, YtmError> {
        if operation_timeout.is_zero() || Instant::now().checked_add(operation_timeout).is_none() {
            return Err(YtmError::invalid_parameter(
                "retrieval",
                "operationTimeout",
                "Retrieval timeout must be positive and representable by the monotonic clock.",
                serde_json::json!(operation_timeout.as_secs_f64()),
            ));
        }
        Ok(Self { operation_timeout })
    }

    pub fn operation_timeout(self) -> Duration {
        self.operation_timeout
    }
}

impl Default for RetrievalOptions {
    fn default() -> Self {
        Self {
            operation_timeout: Duration::from_secs(DEFAULT_OPERATION_TIMEOUT_SECONDS),
        }
    }
}

/// Invocation-local deadline passed through transport decorators.
///
/// Custom transports may cooperate with this context; the service also bounds
/// their asynchronous `post` future. Blocking custom code cannot be preempted.
#[derive(Debug, Clone)]
pub struct RetrievalContext {
    deadline: Instant,
    cancellation: CancellationToken,
    caller_cancellation: CancellationToken,
    // Retain attempt identity until parsing/normalization of that lookup ends.
    // The public Transport return type remains Vec<u8>, preserving custom transports.
    lookup: Arc<Mutex<Option<RetryDetails>>>,
}

impl RetrievalContext {
    pub(crate) fn new(
        options: RetrievalOptions,
        cancellation: CancellationToken,
    ) -> Result<Self, YtmError> {
        let deadline = Instant::now()
            .checked_add(options.operation_timeout)
            .ok_or_else(|| {
                YtmError::invalid_parameter(
                    "retrieval",
                    "operationTimeout",
                    "Retrieval timeout exceeds the monotonic clock range.",
                    serde_json::json!(options.operation_timeout.as_secs_f64()),
                )
            })?;
        Ok(Self {
            deadline,
            cancellation: cancellation.child_token(),
            caller_cancellation: cancellation,
            lookup: Arc::new(Mutex::new(None)),
        })
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    /// A child of the caller's reusable token; cancelling it never cancels the caller.
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn check(&self, operation: &str) -> Result<(), YtmError> {
        if self.caller_cancellation.is_cancelled() {
            Err(self.decorate(
                YtmError::cancelled(operation),
                RetryStopReason::Cancellation,
            )?)
        } else if Instant::now() >= self.deadline {
            self.cancellation.cancel();
            Err(self.decorate(
                YtmError::operation_deadline(operation),
                RetryStopReason::OperationDeadline,
            )?)
        } else {
            Ok(())
        }
    }

    pub(crate) fn clear_lookup(&self) -> Result<(), YtmError> {
        *self.lookup.lock().map_err(|_| YtmError::defect())? = None;
        Ok(())
    }

    pub(crate) fn record_attempt(
        &self,
        operation: &str,
        attempt_count: u8,
        max_attempts: u8,
    ) -> Result<(), YtmError> {
        *self.lookup.lock().map_err(|_| YtmError::defect())? = Some(RetryDetails {
            source_operation: operation.to_owned(),
            attempt_count,
            max_attempts,
            stop_reason: RetryStopReason::TerminalFailure,
        });
        Ok(())
    }

    fn decorate(
        &self,
        mut error: YtmError,
        stop_reason: RetryStopReason,
    ) -> Result<YtmError, YtmError> {
        if error.details.retry.is_none() {
            error.details.retry = self.lookup.lock().map_err(|_| YtmError::defect())?.clone();
            error = error.with_retry_stop(stop_reason);
        }
        Ok(error)
    }

    pub(crate) fn finish<T>(
        &self,
        result: Result<T, YtmError>,
        operation: &str,
    ) -> Result<T, YtmError> {
        if self.caller_cancellation.is_cancelled() {
            let mut cancelled = YtmError::cancelled(operation);
            if let Err(error) = result {
                cancelled.details.retry = error.details.retry;
                cancelled.details.actual = error.details.actual;
                cancelled.details.attempted_dates = error.details.attempted_dates;
                cancelled.details.lookback_days = error.details.lookback_days;
            }
            return Err(self.decorate(
                cancelled.with_retry_stop(RetryStopReason::Cancellation),
                RetryStopReason::Cancellation,
            )?);
        }
        if Instant::now() >= self.deadline {
            self.cancellation.cancel();
            let error = match result {
                Err(error)
                    if matches!(
                        error.details.code,
                        "source_transport_error" | "source_format_error" | "source_protocol_error"
                    ) && error.details.cause.as_deref() != Some("AbortError") =>
                {
                    error
                }
                _ => YtmError::operation_deadline(operation),
            };
            return Err(self.decorate(
                error.with_retry_stop(RetryStopReason::OperationDeadline),
                RetryStopReason::OperationDeadline,
            )?);
        }
        result.map_err(|error| {
            self.decorate(error, RetryStopReason::TerminalFailure)
                .unwrap_or_else(|error| error)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_validate_clock_range_and_default() {
        assert!(RetrievalOptions::new(Duration::ZERO).is_err());
        assert!(RetrievalOptions::new(Duration::MAX).is_err());
        assert_eq!(
            RetrievalOptions::default().operation_timeout(),
            Duration::from_secs(1800)
        );
    }
    #[tokio::test(start_paused = true)]
    async fn cooperative_expiry_never_becomes_missingness_or_caller_cancellation() {
        let caller = CancellationToken::new();
        let context = RetrievalContext::new(
            RetrievalOptions::new(Duration::from_secs(1)).unwrap(),
            caller.clone(),
        )
        .unwrap();
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(
            context
                .check("history")
                .unwrap_err()
                .details
                .cause
                .as_deref(),
            Some("TimeoutError")
        );
        let unavailable = YtmError::unavailable(
            "kinds",
            "2026-06-09",
            None,
            vec!["2026-06-09".into()],
            0,
            false,
        );
        let error = context
            .finish::<()>(Err(unavailable), "history")
            .unwrap_err();
        assert_eq!(error.details.code, "source_transport_error");
        assert_eq!(error.details.cause.as_deref(), Some("TimeoutError"));
        assert!(!caller.is_cancelled());
        let source_cancel = context
            .finish::<()>(Err(YtmError::cancelled("history")), "history")
            .unwrap_err();
        assert_eq!(source_cancel.details.cause.as_deref(), Some("TimeoutError"));
        caller.cancel();
        let cancelled = context
            .finish::<()>(
                Err(YtmError::transport("failure", Some(503), None)),
                "history",
            )
            .unwrap_err();
        assert_eq!(cancelled.details.cause.as_deref(), Some("AbortError"));
        assert!(!cancelled.details.retryable);
    }
}
