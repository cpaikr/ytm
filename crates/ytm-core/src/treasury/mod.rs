//! US Treasury daily par yield curve retrieval, separate from KIS-NET.
//!
//! The service shares date selection, fallback vocabulary, the retrieval
//! context, and the bounded HTTP engine with KIS-NET, but it has its own
//! request, transport trait, result model, and wire contract.

mod parse;

use std::{
    collections::{btree_map::Entry, BTreeMap},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    model::{fallback_policy, fixed_dates},
    transport::{HttpTransport, TreasuryRequest, TreasuryTransport},
    BaseDate, CancellationToken, DateResolution, DateSelection, FallbackMode, FallbackPolicy,
    LookbackDays, RetrievalContext, RetrievalOptions, YtmError,
};

pub use parse::TENORS as TREASURY_TENORS;
use parse::{parse_year, YearFile};

pub const TREASURY_ORIGIN: &str = "https://home.treasury.gov";
pub const TREASURY_PAGE_URL: &str = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve";
pub const TREASURY_DATASET: &str = "daily_treasury_yield_curve";
/// Per-attempt ceiling through decompressed body consumption.
pub const TREASURY_REQUEST_DEADLINE_SECONDS: u64 = 60;

pub(crate) const OPERATION: &str = "treasury";

/// Most distinct yearly files one call may read. A 2,000-day range plus
/// fallback into the prior year spans at most eight; fixed lists share the bound.
pub const MAX_TREASURY_YEARS: usize = 8;
const SOURCE_OPERATION: &str = "treasuryYieldCurve";

/// Prepared lookup for one calendar year's yield curve CSV.
pub(crate) fn year_request(year: u16) -> TreasuryRequest {
    let path = format!(
        "/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type={TREASURY_DATASET}&field_tdr_date_value={year}&page&_format=csv"
    );
    TreasuryRequest {
        operation: SOURCE_OPERATION,
        year,
        url: format!("{TREASURY_ORIGIN}{path}"),
        path,
    }
}

/// Only the exact contract request may be replayed by the core HTTP transport.
pub(crate) fn is_supported_request(request: &TreasuryRequest) -> bool {
    // The contract's year domain is 0..=9999.
    request.year <= 9999 && *request == year_request(request.year)
}

/// Whether `url` has exactly the Treasury origin (scheme, host, and port).
pub(crate) fn is_treasury_origin(url: &str) -> bool {
    let expected = reqwest::Url::parse(TREASURY_ORIGIN).map(|url| url.origin());
    reqwest::Url::parse(url).is_ok_and(|url| expected.is_ok_and(|origin| url.origin() == origin))
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TreasuryCurveInput {
    pub selection: DateSelection,
    pub fallback: FallbackPolicy,
}

impl TreasuryCurveInput {
    pub fn new(selection: DateSelection) -> Self {
        Self {
            selection,
            fallback: FallbackPolicy::Exact,
        }
    }

    pub fn previous_available(selection: DateSelection, lookback_days: LookbackDays) -> Self {
        Self {
            selection,
            fallback: FallbackPolicy::PreviousAvailable(lookback_days),
        }
    }
}

/// Shared wire boundary for adapters; domain validation stays in the core.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreasuryCurveRequest {
    pub base_dates: Option<Vec<String>>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub fallback: Option<String>,
    pub lookback_days: Option<u8>,
}

impl TryFrom<TreasuryCurveRequest> for TreasuryCurveInput {
    type Error = YtmError;

    fn try_from(input: TreasuryCurveRequest) -> Result<Self, Self::Error> {
        Ok(Self {
            selection: fixed_dates(
                OPERATION,
                input.base_dates,
                input.start_date,
                input.end_date,
            )?,
            fallback: fallback_policy(OPERATION, input.fallback, input.lookback_days)?,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TreasuryCurveResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statistics: Option<crate::RetrievalStatistics>,
    pub requested_dates: Vec<BaseDate>,
    pub entries: Vec<TreasuryCurveEntry>,
    pub available_count: usize,
    pub unavailable_count: usize,
    pub mode: FallbackMode,
    pub lookback_days: u8,
    /// Newest observation in any yearly file read. It is a computed maximum
    /// and does not say whether a later date will ever be published.
    pub latest_observation_date: Option<BaseDate>,
    pub source: TreasurySource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "availability", rename_all = "kebab-case")]
pub enum TreasuryCurveEntry {
    Available {
        curve: Box<TreasuryCurve>,
    },
    Unavailable {
        #[serde(rename = "requestedBaseDate")]
        requested_base_date: BaseDate,
        #[serde(rename = "attemptedDates")]
        attempted_dates: Vec<BaseDate>,
        mode: FallbackMode,
        #[serde(rename = "lookbackDays")]
        lookback_days: u8,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TreasuryCurve {
    pub requested_base_date: BaseDate,
    pub base_date: BaseDate,
    pub date_resolution: DateResolution,
    /// Tenors published in the observation's yearly file, in maturity order.
    pub tenors: Vec<TreasuryTenor>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TreasuryTenor {
    /// Canonical maturity label such as `1.5M` or `10Y`.
    pub tenor: &'static str,
    /// Exact source column header such as `1.5 Month` or `10 Yr`.
    pub label: &'static str,
    pub months: f64,
    /// Percent par yield; `None` for a published blank cell.
    #[serde(rename = "yield")]
    pub value: Option<f64>,
    pub yield_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TreasurySource {
    pub page_url: &'static str,
    pub dataset: &'static str,
    pub method: &'static str,
    /// Yearly files read, ascending by year.
    pub files: Vec<TreasurySourceFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TreasurySourceFile {
    pub year: u16,
    pub url: String,
    pub observation_count: usize,
}

pub struct TreasuryService {
    transport: Arc<dyn TreasuryTransport>,
}

impl TreasuryService {
    pub fn new() -> Result<Self, YtmError> {
        Ok(Self::with_shared_transport(Arc::new(HttpTransport::new()?)))
    }

    pub fn with_transport(transport: impl TreasuryTransport + 'static) -> Self {
        Self::with_shared_transport(Arc::new(transport))
    }

    pub fn with_shared_transport(transport: Arc<dyn TreasuryTransport>) -> Self {
        Self { transport }
    }

    pub async fn curve(&self, input: TreasuryCurveInput) -> Result<TreasuryCurveResult, YtmError> {
        self.curve_with_cancellation(input, CancellationToken::new())
            .await
    }

    pub async fn curve_with_cancellation(
        &self,
        input: TreasuryCurveInput,
        cancellation: CancellationToken,
    ) -> Result<TreasuryCurveResult, YtmError> {
        self.curve_with_options_and_cancellation(input, RetrievalOptions::default(), cancellation)
            .await
    }

    pub async fn curve_with_options(
        &self,
        input: TreasuryCurveInput,
        options: RetrievalOptions,
    ) -> Result<TreasuryCurveResult, YtmError> {
        self.curve_with_options_and_cancellation(input, options, CancellationToken::new())
            .await
    }

    pub async fn curve_with_options_and_cancellation(
        &self,
        input: TreasuryCurveInput,
        options: RetrievalOptions,
        cancellation: CancellationToken,
    ) -> Result<TreasuryCurveResult, YtmError> {
        let context = RetrievalContext::new(options, cancellation)?;
        let result = self.curve_in_context(input, &context).await;
        context
            .complete(result, OPERATION)
            .map(|mut result| {
                result.statistics = Some(context.statistics());
                result
            })
            .map_err(retarget)
    }

    async fn curve_in_context(
        &self,
        input: TreasuryCurveInput,
        context: &RetrievalContext,
    ) -> Result<TreasuryCurveResult, YtmError> {
        context.check(OPERATION)?;
        let (mode, lookback_days) = match input.fallback {
            FallbackPolicy::Exact => (FallbackMode::Exact, 0),
            FallbackPolicy::PreviousAvailable(days) => {
                (FallbackMode::PreviousAvailable, days.get())
            }
        };
        check_year_bound(&input.selection, lookback_days)?;
        // Only confirmed file contents enter the cache; failures end the call.
        let mut files: BTreeMap<u16, YearFile> = BTreeMap::new();
        let mut entries = Vec::new();
        let mut available_count = 0;
        for &requested in input.selection.as_dates() {
            context
                .progress()
                .update(|stats| stats.scanned_date_count += 1)?;
            let mut attempted = Vec::new();
            let mut found = None;
            for offset in 0..=u64::from(lookback_days) {
                // Fallback never leaves the supported calendar domain.
                let Some(date) = requested.checked_sub_days(offset) else {
                    break;
                };
                attempted.push(date);
                let year = date.year() as u16;
                if let Entry::Vacant(slot) = files.entry(year) {
                    let file = self.year_file(year, context).await.map_err(|error| {
                        with_context(error, requested, &attempted, lookback_days)
                    })?;
                    slot.insert(file);
                }
                if let Some(tenors) = files[&year].observations.get(&date) {
                    found = Some((date, tenors.clone()));
                    break;
                }
            }
            context
                .check(OPERATION)
                .map_err(|error| with_context(error, requested, &attempted, lookback_days))?;
            entries.push(match found {
                Some((date, tenors)) => {
                    available_count += 1;
                    TreasuryCurveEntry::Available {
                        curve: Box::new(TreasuryCurve {
                            requested_base_date: requested,
                            base_date: date,
                            date_resolution: DateResolution {
                                mode,
                                requested_base_date: requested,
                                resolved_base_date: date,
                                used_fallback: date != requested,
                                attempted_dates: attempted,
                                lookback_days,
                            },
                            tenors,
                        }),
                    }
                }
                None => TreasuryCurveEntry::Unavailable {
                    requested_base_date: requested,
                    attempted_dates: attempted,
                    mode,
                    lookback_days,
                    reason: if lookback_days == 0 {
                        "source_data_unavailable: Treasury published no curve for this date".into()
                    } else {
                        format!("source_data_unavailable: Treasury published no curve for this date or the prior {lookback_days} calendar day(s)")
                    },
                },
            });
        }
        let requested_dates = input.selection.as_dates().to_vec();
        Ok(TreasuryCurveResult {
            statistics: None,
            unavailable_count: requested_dates.len() - available_count,
            requested_dates,
            entries,
            available_count,
            mode,
            lookback_days,
            latest_observation_date: files
                .values()
                .filter_map(|file| file.observations.keys().next_back())
                .max()
                .copied(),
            source: TreasurySource {
                page_url: TREASURY_PAGE_URL,
                dataset: TREASURY_DATASET,
                method: "GET",
                files: files
                    .iter()
                    .map(|(&year, file)| TreasurySourceFile {
                        year,
                        url: year_request(year).url,
                        observation_count: file.observations.len(),
                    })
                    .collect(),
            },
        })
    }

    async fn year_file(&self, year: u16, context: &RetrievalContext) -> Result<YearFile, YtmError> {
        context.clear_lookup()?;
        context.check(OPERATION)?;
        context.progress().begin_lookup(SOURCE_OPERATION)?;
        let token = context.cancellation();
        // Poll the context-aware transport first so its own deadline result can
        // retain the last HTTP failure and attempt metadata at the same instant.
        let response = tokio::select! {
            biased;
            response = self.transport.get_with_context(year_request(year), context.clone()) => response,
            () = token.cancelled() => Err(YtmError::cancelled(OPERATION)),
            () = tokio::time::sleep_until(context.deadline()) => Err(YtmError::operation_deadline(OPERATION)),
        };
        let body = context.finish(response, OPERATION)?;
        context.check(OPERATION)?;
        let file = parse_year(&body, year)?;
        context.check(OPERATION)?;
        context.clear_lookup()?;
        Ok(file)
    }
}

/// Rejects, before any request, a selection whose dates and fallback windows
/// could touch more than `MAX_TREASURY_YEARS` calendar years.
fn check_year_bound(selection: &DateSelection, lookback_days: u8) -> Result<(), YtmError> {
    let mut years = std::collections::BTreeSet::new();
    for &date in selection.as_dates() {
        years.insert(date.year());
        let earliest = date
            .checked_sub_days(u64::from(lookback_days))
            .unwrap_or(date);
        years.insert(earliest.year());
    }
    if years.len() <= MAX_TREASURY_YEARS {
        return Ok(());
    }
    let mut error = YtmError::invalid_parameter(
        OPERATION,
        "baseDates",
        format!(
            "The selection and its fallback window touch {} calendar years; at most {MAX_TREASURY_YEARS} yearly files may be read per call.",
            years.len()
        ),
        json!(years),
    );
    error.details.recovery_hint =
        format!("Split the selection into calls that each touch at most {MAX_TREASURY_YEARS} calendar years.");
    Err(error)
}

fn with_context(
    mut error: YtmError,
    requested: BaseDate,
    attempted: &[BaseDate],
    lookback_days: u8,
) -> YtmError {
    error.details.operation_name = Some(OPERATION.into());
    error.details.attempted_dates = Some(attempted.iter().map(ToString::to_string).collect());
    error.details.lookback_days = Some(lookback_days);
    error.details.actual = Some(json!({
        "requestedBaseDate": requested,
        "attemptedDate": attempted.last(),
        "sourceActual": error.details.actual.take(),
    }));
    error
}

/// Shared error constructors describe KIS-NET; restate source guidance for Treasury.
pub(crate) fn retarget(mut error: YtmError) -> YtmError {
    let details = &mut error.details;
    match details.code {
        "source_transport_error" if details.cause.as_deref() == Some("AbortError") => {
            if details.reason == "KIS-NET request was cancelled." {
                details.reason = "Treasury request was cancelled.".into();
            }
        }
        "source_transport_error" => {
            details.expected = Some(json!("A successful HTTP response from Treasury"));
            if details.recovery_hint == "Retry later or inspect whether KIS-NET is available." {
                details.recovery_hint =
                    "Retry later or inspect whether the Treasury site is available.".into();
            }
        }
        "source_format_error" => {
            details.expected = Some(json!(
                "A Treasury daily par yield curve CSV matching the documented schema"
            ));
            details.recovery_hint =
                "The Treasury source format may have changed; update this client before retrying."
                    .into();
        }
        _ => {}
    }
    error
}

#[cfg(test)]
mod tests;
