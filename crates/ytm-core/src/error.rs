use serde::Serialize;
use serde_json::Value;
use std::fmt;

use crate::model::{BaseDate, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS};

const SOURCE_DATA_UNAVAILABLE_CODE: &str = "source_data_unavailable";

/// Why the last physical HTTP lookup stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryStopReason {
    TerminalFailure,
    AttemptExhaustion,
    OperationDeadline,
    Cancellation,
}

/// Attempts of one failing lookup, independent of history's attempted dates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryDetails {
    pub attempt_count: u8,
    pub max_attempts: u8,
    pub source_operation: String,
    pub stop_reason: RetryStopReason,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetails {
    pub ok: bool,
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example_input: Option<Value>,
    pub recovery_hint: String,
    pub recovery_action: &'static str,
    pub recoverable: bool,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_dates: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lookback_days: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statistics: Option<crate::RetrievalStatistics>,
}

#[derive(Debug, Clone)]
pub struct YtmError {
    pub details: Box<ErrorDetails>,
}

impl fmt::Display for YtmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.details.code, self.details.reason)
    }
}

impl std::error::Error for YtmError {}

impl YtmError {
    pub(crate) fn with_retry_stop(mut self, reason: RetryStopReason) -> Self {
        if let Some(retry) = &mut self.details.retry {
            retry.stop_reason = reason;
        }
        self
    }

    pub(crate) fn operation_deadline(operation: &str) -> Self {
        let mut error = Self::transport(
            "The overall retrieval deadline was reached.",
            None,
            Some("TimeoutError"),
        );
        error.details.operation_name = Some(operation.to_owned());
        error.details.recovery_hint =
            "Retry later or select a larger finite retrieval timeout.".into();
        error
    }

    pub(crate) fn is_unavailable(&self) -> bool {
        self.details.code == SOURCE_DATA_UNAVAILABLE_CODE
    }

    pub(crate) fn with_source_context(
        mut self,
        operation: &str,
        attempted_dates: &[BaseDate],
        lookback_days: u8,
    ) -> Self {
        if matches!(
            self.details.code,
            "source_transport_error" | "source_format_error" | "source_protocol_error"
        ) {
            self.details.operation_name = Some(operation.to_owned());
            self.details.attempted_dates =
                Some(attempted_dates.iter().map(ToString::to_string).collect());
            self.details.lookback_days = Some(lookback_days);
        }
        self
    }

    /// Build the shared cancellation error for adapters and custom transports.
    pub fn cancelled(operation: &str) -> Self {
        Self::cancelled_with_reason(operation, "KIS-NET request was cancelled.")
    }

    pub(crate) fn cancelled_with_reason(operation: &str, reason: impl Into<String>) -> Self {
        let mut error = Self::transport(reason, None, Some("AbortError"));
        error.details.operation_name = Some(operation.to_owned());
        error.details.expected = Some(Value::String(
            "A request that remains active until completion".into(),
        ));
        error.details.recovery_hint =
            "Start a new request with a non-aborted cancellation signal if the operation is still needed."
                .into();
        error.details.recovery_action = "start_new_request";
        error
    }

    pub fn invalid_parameter(
        operation: &str,
        parameter: &str,
        reason: impl Into<String>,
        actual: Value,
    ) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "invalid_parameter",
            operation_name: Some(operation.to_owned()),
            parameter: Some(parameter.to_owned()),
            reason: reason.into(),
            expected: None,
            actual: Some(actual),
            example_input: None,
            recovery_hint: "Inspect command help and retry with a supported value.".into(),
            recovery_action: "inspect_command_help",
            recoverable: true,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
            retry: None,
            statistics: None,
        })
    }

    pub fn unsupported_kind(actual: &str, expected: Value, example_input: Value) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "invalid_parameter",
            operation_name: Some("matrix".into()),
            parameter: Some("kind".into()),
            reason: format!("Unknown 종류: {actual}."),
            expected: Some(expected),
            actual: Some(Value::String(actual.to_owned())),
            example_input: Some(example_input),
            recovery_hint:
                "Use kinds to inspect accepted 종류 values, then retry with a listed code or label."
                    .into(),
            recovery_action: "inspect_command_help",
            recoverable: true,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
            retry: None,
            statistics: None,
        })
    }

    pub fn transport(reason: impl Into<String>, status: Option<u16>, cause: Option<&str>) -> Self {
        let cancelled = cause == Some("AbortError");
        Self::new(ErrorDetails {
            ok: false,
            code: "source_transport_error",
            operation_name: None,
            parameter: None,
            reason: reason.into(),
            expected: Some(Value::String(
                "A successful HTTP response from KIS-NET".into(),
            )),
            actual: status.map(|value| Value::from(u64::from(value))),
            example_input: None,
            recovery_hint: "Retry later or inspect whether KIS-NET is available.".into(),
            recovery_action: "inspect_tool_help",
            recoverable: !cancelled,
            retryable: !cancelled,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: cause.map(str::to_owned),
            retry: None,
            statistics: None,
        })
    }

    pub fn format(reason: impl Into<String>) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "source_format_error",
            operation_name: None,
            parameter: None,
            reason: reason.into(),
            expected: Some(Value::String(
                "A valid KIS-NET Nexacro response matching the documented YTM Matrix schema".into(),
            )),
            actual: None,
            example_input: None,
            recovery_hint:
                "The KIS-NET source format may have changed; update this client before retrying."
                    .into(),
            recovery_action: "inspect_tool_help",
            recoverable: false,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
            retry: None,
            statistics: None,
        })
    }

    pub fn protocol(code: String, message: Option<String>) -> Self {
        let suffix = message
            .as_ref()
            .map(|value| format!(" ({value})"))
            .unwrap_or_default();
        Self::new(ErrorDetails {
            ok: false,
            code: "source_protocol_error",
            operation_name: None,
            parameter: None,
            reason: format!("KIS-NET returned nonzero Nexacro ErrorCode {code}{suffix}."),
            expected: Some(Value::String("Nexacro ErrorCode 0".into())),
            actual: Some(Value::String(code.clone())),
            example_input: None,
            recovery_hint: "Inspect the preserved KIS-NET status before deciding whether the request can be retried.".into(),
            recovery_action: "inspect_tool_help",
            recoverable: false,
            retryable: false,
            source_error_code: Some(code),
            source_error_message: message,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
            retry: None,
            statistics: None,
        })
    }

    pub fn unavailable(
        operation: &str,
        base_date: &str,
        kind: Option<&str>,
        attempted_dates: Vec<String>,
        lookback_days: u8,
        exhausted: bool,
    ) -> Self {
        let reason = if exhausted {
            format!("KIS-NET returned no YTM Matrix rows for {base_date} or the prior {lookback_days} calendar day(s).")
        } else if operation == "kinds" {
            format!("KIS-NET returned no 종류 values for {base_date}. It may be a weekend, holiday, or unavailable source date.")
        } else {
            format!("KIS-NET returned no YTM Matrix rows for {base_date}. It may be a weekend, holiday, or unavailable source date.")
        };
        let nearby_date = base_date
            .parse::<BaseDate>()
            .ok()
            .and_then(|date| date.checked_sub_days(1))
            .map(|date| date.to_string());
        let example_input = if operation == "matrix" && exhausted {
            nearby_date
                .map(|date| serde_json::json!({ "baseDate": date, "kind": kind.unwrap_or("국채") }))
                .unwrap_or_else(|| serde_json::json!({ "kind": kind.unwrap_or("국채") }))
        } else if operation == "matrix" {
            serde_json::json!({
                "baseDate": base_date,
                "kind": kind.unwrap_or("국채"),
                "fallback": "previous-available",
                "lookbackDays": DEFAULT_LOOKBACK_DAYS
            })
        } else {
            nearby_date
                .map(|date| serde_json::json!({ "baseDate": date }))
                .unwrap_or_else(|| serde_json::json!({}))
        };
        Self::new(ErrorDetails {
            ok: false,
            code: SOURCE_DATA_UNAVAILABLE_CODE,
            operation_name: Some(operation.to_owned()),
            parameter: Some("baseDate".into()),
            reason,
            expected: Some(Value::String(
                "KIS-NET data for an available business 기준일".into(),
            )),
            actual: Some(Value::String(base_date.to_owned())),
            example_input: Some(example_input),
            recovery_hint: if exhausted {
                format!("No data was found in the fallback window. Try a known business day, or increase lookbackDays up to {MAX_LOOKBACK_DAYS}.")
            } else if operation == "kinds" {
                "Try a nearby business day.".into()
            } else {
                "Try a nearby business day, or rerun matrix with fallback=previous-available."
                    .into()
            },
            recovery_action: if operation == "matrix" && !exhausted {
                "use_previous_available_fallback"
            } else {
                "try_nearby_business_day"
            },
            recoverable: true,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: Some(attempted_dates),
            lookback_days: Some(lookback_days),
            cause: None,
            retry: None,
            statistics: None,
        })
    }

    pub(crate) fn insufficient_history(
        count: usize,
        found: usize,
        start: BaseDate,
        end: BaseDate,
        scanned: usize,
        reason: &str,
    ) -> Self {
        let mut error = Self::invalid_parameter(
            "history",
            "count",
            "Not enough distinct dates containing numeric yields within the search boundary.",
            serde_json::json!({
                "foundCount": found, "scannedStartDate": start, "scannedEndDate": end,
                "scannedDateCount": scanned, "stopReason": reason
            }),
        );
        error.details.code = "insufficient_history";
        error.details.expected = Some(serde_json::json!({"count": count}));
        error.details.recovery_action = "adjust_history_selection";
        let limit = crate::MAX_HISTORY_DATES;
        error.details.recovery_hint = match reason {
            "start_boundary" => format!(
                "Lower count or move startDate earlier within the {limit}-day search limit."
            ),
            "search_limit" => format!(
                "Lower count or choose an endDate whose prior {limit} days contain more data."
            ),
            _ => "Lower count or choose a later endDate; the calendar date floor was reached."
                .to_owned(),
        };
        error
    }

    pub fn defect() -> Self {
        Self::defect_with_reason("The native ytm core encountered an internal defect.")
    }

    pub fn defect_with_reason(reason: impl Into<String>) -> Self {
        Self::new(ErrorDetails {
            ok: false,
            code: "internal_error",
            operation_name: None,
            parameter: None,
            reason: reason.into(),
            expected: None,
            actual: None,
            example_input: None,
            recovery_hint:
                "Update the package or report the failure without including source response bodies."
                    .into(),
            recovery_action: "update_package",
            recoverable: false,
            retryable: false,
            source_error_code: None,
            source_error_message: None,
            attempted_dates: None,
            lookback_days: None,
            cause: None,
            retry: None,
            statistics: None,
        })
    }

    fn new(details: ErrorDetails) -> Self {
        Self {
            details: Box::new(details),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_recovery_examples_stay_inside_the_base_date_domain() {
        let error = YtmError::unavailable(
            "kinds",
            "0000-01-01",
            None,
            vec!["0000-01-01".into()],
            0,
            false,
        );

        assert_eq!(error.details.example_input, Some(serde_json::json!({})));
    }

    #[test]
    fn cancellation_metadata_is_terminal_and_actionable() {
        let error = YtmError::cancelled("matrix");

        assert_eq!(error.details.code, "source_transport_error");
        assert_eq!(error.details.operation_name.as_deref(), Some("matrix"));
        assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
        assert!(!error.details.recoverable);
        assert!(!error.details.retryable);
        assert_eq!(error.details.recovery_action, "start_new_request");
        assert!(error.details.recovery_hint.contains("new request"));
    }
}
