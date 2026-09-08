use std::{collections::HashMap, sync::Arc};

use indexmap::IndexMap;
use serde_json::json;

use crate::{
    error::YtmError,
    model::{
        canonical_kinds, BaseDate, Capabilities, CountSelectionMetadata, DateResolution,
        FallbackMode, FallbackPolicy, HistoryDiscovery, HistoryEntry, HistoryInput, HistoryResult,
        HistorySelection, Kind, KindsInput, KindsResult, MatrixInput, MatrixResult, MatrixRow,
        SourceMetadata, SourceParameters, SourceRequest, UnavailableStage, TENORS,
    },
    nexacro,
    request::{self, INIT_PATH, MATRIX_PATH, SOURCE_ORIGIN, SOURCE_PAGE_URL},
    transport::{HttpTransport, Transport},
    CancellationToken,
};

type MatrixObservation = (Kind, Vec<MatrixRow>, SourceMetadata);

pub struct YtmService {
    transport: Arc<dyn Transport>,
}

impl YtmService {
    pub fn new() -> Result<Self, YtmError> {
        Ok(Self::with_shared_transport(HttpTransport::shared()?))
    }

    pub fn with_transport(transport: impl Transport + 'static) -> Self {
        Self::with_shared_transport(Arc::new(transport))
    }

    pub fn with_shared_transport(transport: Arc<dyn Transport>) -> Self {
        Self { transport }
    }

    pub fn capabilities() -> Capabilities {
        Capabilities::current()
    }

    pub async fn kinds(&self, input: KindsInput) -> Result<KindsResult, YtmError> {
        self.kinds_with_cancellation(input, CancellationToken::new())
            .await
    }

    pub async fn kinds_with_cancellation(
        &self,
        input: KindsInput,
        cancellation: CancellationToken,
    ) -> Result<KindsResult, YtmError> {
        check_cancellation(&cancellation, "kinds")?;
        let Some(base_date) = input.base_date else {
            let result = KindsResult {
                base_date: None,
                kinds: canonical_kinds(),
                source: SourceMetadata {
                    page_url: SOURCE_PAGE_URL,
                    endpoint: None,
                    method: None,
                    request: None,
                    inspected_workflow: None,
                    note: Some("Canonical 종류 catalog owned by the Rust ytm core. Provide baseDate to merge live discovery."),
                },
            };
            check_cancellation(&cancellation, "kinds")?;
            return Ok(result);
        };
        let compact = base_date.compact();
        let result = self
            .kinds_for_date(base_date, &compact, &cancellation)
            .await;
        if cancellation.is_cancelled() {
            return Err(YtmError::cancelled("kinds").with_source_context(
                "kinds",
                std::slice::from_ref(&base_date),
                0,
            ));
        }
        result
    }

    pub async fn matrix(&self, input: MatrixInput) -> Result<MatrixResult, YtmError> {
        self.matrix_with_cancellation(input, CancellationToken::new())
            .await
    }

    pub async fn matrix_with_cancellation(
        &self,
        input: MatrixInput,
        cancellation: CancellationToken,
    ) -> Result<MatrixResult, YtmError> {
        check_cancellation(&cancellation, "matrix")?;
        let requested_date = input.base_date;
        let kind_input = input.kind.as_str().to_owned();
        let (fallback, lookback_days) = match input.fallback {
            FallbackPolicy::Exact => (FallbackMode::Exact, 0),
            FallbackPolicy::PreviousAvailable(days) => {
                (FallbackMode::PreviousAvailable, days.get())
            }
        };
        let mut attempted_dates = Vec::new();
        for offset in 0..=u64::from(lookback_days) {
            if cancellation.is_cancelled() {
                return Err(YtmError::cancelled("matrix").with_source_context(
                    "matrix",
                    &attempted_dates,
                    lookback_days,
                ));
            }
            let date = requested_date.checked_sub_days(offset).ok_or_else(|| {
                YtmError::invalid_parameter(
                    "matrix",
                    "baseDate",
                    "baseDate fallback underflowed.",
                    json!(requested_date),
                )
            })?;
            let compact = date.compact();
            check_cancellation(&cancellation, "matrix").map_err(|error| {
                error.with_source_context("matrix", &attempted_dates, lookback_days)
            })?;
            attempted_dates.push(date);
            let result = self
                .matrix_for_date(date, &compact, &kind_input, cancellation.clone())
                .await;
            if cancellation.is_cancelled() {
                return Err(YtmError::cancelled("matrix").with_source_context(
                    "matrix",
                    &attempted_dates,
                    lookback_days,
                ));
            }
            match result {
                Ok((kind, rows, source)) => {
                    let result = MatrixResult {
                        base_date: date,
                        requested_base_date: requested_date,
                        date_resolution: DateResolution {
                            mode: fallback,
                            requested_base_date: requested_date,
                            resolved_base_date: date,
                            used_fallback: date != requested_date,
                            attempted_dates: attempted_dates.clone(),
                            lookback_days,
                        },
                        kind,
                        tenors: TENORS
                            .iter()
                            .map(|(_, label)| (*label).to_owned())
                            .collect(),
                        rows,
                        source,
                    };
                    check_cancellation(&cancellation, "matrix").map_err(|error| {
                        error.with_source_context("matrix", &attempted_dates, lookback_days)
                    })?;
                    return Ok(result);
                }
                Err(error)
                    if error.is_unavailable()
                        && fallback == FallbackMode::PreviousAvailable
                        && offset < u64::from(lookback_days) => {}
                Err(error) if error.is_unavailable() => {
                    if cancellation.is_cancelled() {
                        return Err(YtmError::cancelled("matrix").with_source_context(
                            "matrix",
                            &attempted_dates,
                            lookback_days,
                        ));
                    }
                    return Err(YtmError::unavailable(
                        "matrix",
                        &requested_date.to_string(),
                        Some(&kind_input),
                        attempted_dates.iter().map(ToString::to_string).collect(),
                        lookback_days,
                        fallback == FallbackMode::PreviousAvailable,
                    ));
                }
                Err(error) => {
                    return Err(error.with_source_context(
                        "matrix",
                        &attempted_dates,
                        lookback_days,
                    ))
                }
            }
        }
        if cancellation.is_cancelled() {
            return Err(YtmError::cancelled("matrix").with_source_context(
                "matrix",
                &attempted_dates,
                lookback_days,
            ));
        }
        Err(YtmError::unavailable(
            "matrix",
            &requested_date.to_string(),
            Some(&kind_input),
            attempted_dates.iter().map(ToString::to_string).collect(),
            lookback_days,
            fallback == FallbackMode::PreviousAvailable,
        ))
    }

    pub async fn history(&self, input: HistoryInput) -> Result<HistoryResult, YtmError> {
        self.history_with_cancellation(input, CancellationToken::new())
            .await
    }

    pub async fn history_with_cancellation(
        &self,
        input: HistoryInput,
        cancellation: CancellationToken,
    ) -> Result<HistoryResult, YtmError> {
        let (mode, lookback_days) = match input.fallback {
            FallbackPolicy::Exact => (FallbackMode::Exact, 0),
            FallbackPolicy::PreviousAvailable(days) => {
                (FallbackMode::PreviousAvailable, days.get())
            }
        };
        let count_selection = match &input.selection {
            HistorySelection::Count(selection) => {
                if input.fallback != FallbackPolicy::Exact {
                    return Err(YtmError::invalid_parameter(
                        "history",
                        "fallback",
                        "Count selection requires exact fallback.",
                        json!("previous-available"),
                    ));
                }
                Some(selection)
            }
            HistorySelection::Dates(_) => None,
        };
        let candidates = match &input.selection {
            HistorySelection::Dates(dates) => dates.as_dates().to_vec(),
            HistorySelection::Count(selection) => (0..crate::MAX_HISTORY_DATES)
                .map_while(|offset| selection.end_date().checked_sub_days(offset as u64))
                .take_while(|date| selection.start_date().is_none_or(|start| *date >= start))
                .collect(),
        };
        let mut result = HistoryResult {
            count_selection: None,
            requested_dates: Vec::new(),
            discovery: Vec::new(),
            entries: Vec::new(),
            available_count: 0,
            unavailable_count: 0,
            data_row_count: 0,
            mode,
            lookback_days,
        };
        let mut days = Vec::new();
        let mut scanned = 0;
        // Only confirmed outcomes enter these invocation-local caches. Operational
        // failures terminate the call immediately and are never stored as missingness.
        let mut catalogs: HashMap<BaseDate, Option<KindsResult>> = HashMap::new();
        let mut observations: HashMap<(BaseDate, String), Option<MatrixObservation>> =
            HashMap::new();
        for &requested in &candidates {
            scanned += 1;
            let mut day = self
                .history_day(
                    requested,
                    mode,
                    lookback_days,
                    &mut catalogs,
                    &mut observations,
                    &cancellation,
                )
                .await?;
            let qualifies = day.entries.iter().any(|entry| match entry {
                HistoryEntry::Available { matrix } => matrix
                    .rows
                    .iter()
                    .any(|row| row.yields.values().any(Option::is_some)),
                HistoryEntry::Unavailable { .. } => false,
            });
            if count_selection.is_none() || qualifies {
                day.requested_dates.push(requested);
                days.push(day);
            }
            if let Some(selection) = count_selection {
                // Backward exact traversal never revisits a date. Drop rejected data immediately.
                catalogs.clear();
                observations.clear();
                if days.len() == selection.count() {
                    result.count_selection = Some(CountSelectionMetadata {
                        count: selection.count(),
                        end_date: selection.end_date(),
                        start_date: selection.start_date(),
                        scanned_start_date: requested,
                        scanned_date_count: scanned,
                    });
                    break;
                }
            } else {
                let oldest = requested
                    .checked_sub_days(u64::from(lookback_days))
                    .unwrap_or(requested);
                observations.retain(|(date, _), _| *date >= oldest);
                catalogs.retain(|date, _| *date >= oldest);
            }
        }
        check_cancellation(&cancellation, "history")?;
        if let Some(selection) = count_selection {
            if days.len() != selection.count() {
                let start = *candidates
                    .last()
                    .expect("validated count search has an end date");
                let reason = if selection.start_date() == Some(start) {
                    "start_boundary"
                } else if scanned == crate::MAX_HISTORY_DATES {
                    "search_limit"
                } else {
                    "date_floor"
                };
                return Err(YtmError::insufficient_history(
                    selection.count(),
                    days.len(),
                    start,
                    selection.end_date(),
                    scanned,
                    reason,
                ));
            }
            days.reverse();
        }
        for day in days {
            result.requested_dates.extend(day.requested_dates);
            result.discovery.extend(day.discovery);
            result.entries.extend(day.entries);
            result.available_count += day.available_count;
            result.unavailable_count += day.unavailable_count;
            result.data_row_count += day.data_row_count;
        }
        Ok(result)
    }

    async fn history_day(
        &self,
        requested: BaseDate,
        mode: FallbackMode,
        lookback_days: u8,
        catalogs: &mut HashMap<BaseDate, Option<KindsResult>>,
        observations: &mut HashMap<(BaseDate, String), Option<MatrixObservation>>,
        cancellation: &CancellationToken,
    ) -> Result<HistoryResult, YtmError> {
        let mut result = HistoryResult {
            count_selection: None,
            requested_dates: Vec::new(),
            discovery: Vec::new(),
            entries: Vec::new(),
            available_count: 0,
            unavailable_count: 0,
            data_row_count: 0,
            mode,
            lookback_days,
        };

        let discovery = self
            .history_catalog(requested, catalogs, cancellation)
            .await
            .map_err(|e| history_error(e, requested, None, &[requested], lookback_days))?;
        let targets = discovery
            .as_ref()
            .map(|v| v.kinds.clone())
            .unwrap_or_else(canonical_kinds);
        result.discovery.push(HistoryDiscovery {
            requested_base_date: requested,
            available: discovery.is_some(),
        });
        for kind in targets {
            let mut attempted = Vec::new();
            let mut available = None;
            let mut stage = UnavailableStage::Discovery;
            for offset in 0..=u64::from(lookback_days) {
                let date = requested.checked_sub_days(offset).ok_or_else(|| {
                    history_error(
                        YtmError::invalid_parameter(
                            "history",
                            "dates",
                            "History fallback underflowed the calendar date domain.",
                            json!(requested),
                        ),
                        requested,
                        Some(&kind),
                        &attempted,
                        lookback_days,
                    )
                })?;
                attempted.push(date);
                let context =
                    |e| history_error(e, requested, Some(&kind), &attempted, lookback_days);
                check_cancellation(cancellation, "history").map_err(context)?;
                let catalog = self
                    .history_catalog(date, catalogs, cancellation)
                    .await
                    .map_err(context)?;
                if catalog.is_none() {
                    stage = UnavailableStage::Discovery;
                    continue;
                }
                stage = UnavailableStage::Matrix;
                let key = (date, kind.code.clone());
                if !observations.contains_key(&key) {
                    let observation_kind = catalog
                        .as_ref()
                        .and_then(|c| c.kinds.iter().find(|k| k.code == kind.code))
                        .cloned()
                        .unwrap_or_else(|| kind.clone());
                    let observation = self
                        .matrix_for_kind(
                            date,
                            &date.compact(),
                            observation_kind,
                            cancellation.clone(),
                        )
                        .await;
                    check_cancellation(cancellation, "history").map_err(context)?;
                    let value = match observation {
                        Ok(value) => Some(value),
                        Err(e) if e.is_unavailable() => None,
                        Err(e) => return Err(context(e)),
                    };
                    observations.insert(key.clone(), value);
                }
                if let Some((observed_kind, rows, source)) = &observations[&key] {
                    available = Some(MatrixResult {
                        base_date: date,
                        requested_base_date: requested,
                        kind: observed_kind.clone(),
                        tenors: TENORS
                            .iter()
                            .map(|(_, label)| (*label).to_owned())
                            .collect(),
                        rows: rows.clone(),
                        source: source.clone(),
                        date_resolution: DateResolution {
                            mode,
                            requested_base_date: requested,
                            resolved_base_date: date,
                            used_fallback: date != requested,
                            attempted_dates: attempted.clone(),
                            lookback_days,
                        },
                    });
                    break;
                }
            }
            check_cancellation(cancellation, "history")
                .map_err(|e| history_error(e, requested, Some(&kind), &attempted, lookback_days))?;
            if let Some(matrix) = available {
                result.available_count += 1;
                result.data_row_count += matrix.rows.len();
                result.entries.push(HistoryEntry::Available {
                    matrix: Box::new(matrix),
                });
            } else {
                result.unavailable_count += 1;
                let reason = match stage {
                    UnavailableStage::Discovery => {
                        "source_data_unavailable: dated catalog discovery returned no kinds"
                    }
                    UnavailableStage::Matrix => "source_data_unavailable: matrix returned no rows",
                }
                .to_owned();
                result.entries.push(HistoryEntry::Unavailable {
                    requested_base_date: requested,
                    kind,
                    attempted_dates: attempted,
                    mode,
                    lookback_days,
                    reason,
                    stage,
                });
            }
        }
        Ok(result)
    }

    async fn history_catalog(
        &self,
        date: BaseDate,
        cache: &mut HashMap<BaseDate, Option<KindsResult>>,
        cancellation: &CancellationToken,
    ) -> Result<Option<KindsResult>, YtmError> {
        check_cancellation(cancellation, "history")?;
        if let Some(value) = cache.get(&date) {
            return Ok(value.clone());
        }
        let value = match self
            .kinds_for_date(date, &date.compact(), cancellation)
            .await
        {
            Ok(value) => Some(value),
            Err(e) if e.is_unavailable() => None,
            Err(e) => return Err(e),
        };
        check_cancellation(cancellation, "history")?;
        cache.insert(date, value.clone());
        Ok(value)
    }

    async fn kinds_for_date(
        &self,
        display: BaseDate,
        compact: &str,
        cancellation: &CancellationToken,
    ) -> Result<KindsResult, YtmError> {
        let attempted_dates = [display];
        let response = self
            .post(request::init(compact), cancellation, "kinds")
            .await
            .map_err(|error| error.with_source_context("kinds", &attempted_dates, 0))?;
        check_cancellation(cancellation, "kinds")?;
        let dataset = nexacro::parse(&response, "output1")
            .map_err(|error| error.with_source_context("kinds", &attempted_dates, 0))?;
        check_cancellation(cancellation, "kinds")?;
        if dataset.rows.is_empty() {
            return Err(YtmError::unavailable(
                "kinds",
                &display.to_string(),
                None,
                vec![display.to_string()],
                0,
                false,
            ));
        }
        let mut discovered = Vec::with_capacity(dataset.rows.len());
        for row in dataset.rows {
            check_cancellation(cancellation, "kinds")?;
            let kind = kind_from_row(row)
                .map_err(|error| error.with_source_context("kinds", &attempted_dates, 0))?;
            check_cancellation(cancellation, "kinds")?;
            discovered.push(kind);
        }
        let kinds = merge_kinds_with_cancellation(discovered, cancellation)
            .map_err(|error| error.with_source_context("kinds", &attempted_dates, 0))?;
        check_cancellation(cancellation, "kinds")?;
        let result = KindsResult {
            base_date: Some(display),
            kinds,
            source: source_metadata(INIT_PATH, "ds_tymSort=output1 ds_list=output2", compact, "10", "The mobile page posts ds_search to /rateInfo/ytmMatrixMobileInitList.do on initial YTM Matrix load."),
        };
        check_cancellation(cancellation, "kinds")?;
        Ok(result)
    }

    async fn matrix_for_date(
        &self,
        display: BaseDate,
        compact: &str,
        kind_input: &str,
        cancellation: CancellationToken,
    ) -> Result<(Kind, Vec<MatrixRow>, SourceMetadata), YtmError> {
        let attempted_dates = [display];
        let kinds = self
            .kinds_for_date(display, compact, &cancellation)
            .await
            .map_err(|error| error.with_source_context("matrix", &attempted_dates, 0))?
            .kinds;
        check_cancellation(&cancellation, "matrix")?;
        let kind = resolve_kind_with_cancellation(kind_input, &kinds, &cancellation)?;
        let Some(kind) = kind else {
            return Err(YtmError::unsupported_kind(
                kind_input,
                json!(kinds),
                json!({
                    "baseDate": display.to_string(),
                    "kind": kinds.first().map(|kind| kind.name.as_str()).unwrap_or("국채")
                }),
            ));
        };
        self.matrix_for_kind(display, compact, kind, cancellation)
            .await
    }

    async fn matrix_for_kind(
        &self,
        display: BaseDate,
        compact: &str,
        kind: Kind,
        cancellation: CancellationToken,
    ) -> Result<(Kind, Vec<MatrixRow>, SourceMetadata), YtmError> {
        let attempted_dates = [display];
        check_cancellation(&cancellation, "matrix")?;
        let response = self
            .post(
                request::matrix(compact, &kind.code),
                &cancellation,
                "matrix",
            )
            .await
            .map_err(|error| error.with_source_context("matrix", &attempted_dates, 0))?;
        check_cancellation(&cancellation, "matrix")?;
        let dataset = nexacro::parse(&response, "output1")
            .map_err(|error| error.with_source_context("matrix", &attempted_dates, 0))?;
        check_cancellation(&cancellation, "matrix")?;
        if dataset.rows.is_empty() {
            return Err(YtmError::unavailable(
                "matrix",
                &display.to_string(),
                Some(&kind.code),
                vec![display.to_string()],
                0,
                false,
            ));
        }
        let mut rows = Vec::with_capacity(dataset.rows.len());
        for row in dataset.rows {
            check_cancellation(&cancellation, "matrix")?;
            let row = normalize_row_with_cancellation(row, &kind, &cancellation)
                .map_err(|error| error.with_source_context("matrix", &attempted_dates, 0))?;
            check_cancellation(&cancellation, "matrix")?;
            rows.push(row);
        }
        check_cancellation(&cancellation, "matrix")?;
        let source = source_metadata(
            MATRIX_PATH,
            "ds_list=output1",
            compact,
            &kind.code,
            "The mobile page posts ds_search to /rateInfo/ytmMatrixMobileList.do when 검색 is clicked.",
        );
        check_cancellation(&cancellation, "matrix")?;
        Ok((kind, rows, source))
    }

    async fn post(
        &self,
        request: crate::PreparedRequest,
        cancellation: &CancellationToken,
        operation: &str,
    ) -> Result<Vec<u8>, YtmError> {
        check_cancellation(cancellation, operation)?;
        let response = self.transport.post(request, cancellation.clone()).await;
        if cancellation.is_cancelled() {
            return Err(YtmError::cancelled(operation));
        }
        response
    }
}

fn history_error(
    mut error: YtmError,
    requested: BaseDate,
    kind: Option<&Kind>,
    attempted: &[BaseDate],
    lookback: u8,
) -> YtmError {
    error.details.operation_name = Some("history".into());
    error.details.attempted_dates = Some(attempted.iter().map(ToString::to_string).collect());
    error.details.lookback_days = Some(lookback);
    // Preserve the source's original actual payload alongside batch context.
    error.details.actual = Some(json!({ "requestedBaseDate": requested, "kind": kind,
        "attemptedDate": attempted.last(), "sourceActual": error.details.actual.take() }));
    error
}

fn check_cancellation(cancellation: &CancellationToken, operation: &str) -> Result<(), YtmError> {
    if cancellation.is_cancelled() {
        return Err(YtmError::cancelled(operation));
    }
    Ok(())
}

fn kind_from_row(row: IndexMap<String, String>) -> Result<Kind, YtmError> {
    let code = row
        .get("divCode")
        .map(|value| value.trim())
        .unwrap_or_default();
    let name = row
        .get("divName")
        .map(|value| value.trim())
        .unwrap_or_default();
    if code.is_empty() || name.is_empty() {
        return Err(YtmError::format(
            "KIS-NET kind row is missing divCode or divName.",
        ));
    }
    Ok(Kind {
        code: code.into(),
        name: name.into(),
    })
}

#[cfg(test)]
fn merge_kinds(discovered: Vec<Kind>) -> Result<Vec<Kind>, YtmError> {
    merge_kinds_with_cancellation(discovered, &CancellationToken::new())
}

fn merge_kinds_with_cancellation(
    discovered: Vec<Kind>,
    cancellation: &CancellationToken,
) -> Result<Vec<Kind>, YtmError> {
    let mut canonical = canonical_kinds();
    let canonical_labels_by_code = canonical
        .iter()
        .map(|kind| (kind.code.clone(), kind_label_key(&kind.name)))
        .collect::<HashMap<_, _>>();
    let mut label_owners = canonical
        .iter()
        .map(|kind| (kind_label_key(&kind.name), (kind.code.clone(), true)))
        .collect::<HashMap<_, _>>();
    let mut live_only_by_code = IndexMap::<String, String>::new();

    for kind in discovered {
        check_cancellation(cancellation, "kinds")?;
        let label_key = kind_label_key(&kind.name);
        if let Some(previous) = live_only_by_code.get(&kind.code) {
            if kind_label_key(previous) != label_key {
                return Err(YtmError::format(format!(
                    "KIS-NET discovery returned conflicting labels for kind code {}.",
                    kind.code
                )));
            }
            continue;
        }

        if let Some((owner_code, canonical_owner)) = label_owners.get(&label_key) {
            if owner_code != &kind.code {
                let qualifier = if *canonical_owner { "canonical " } else { "" };
                return Err(YtmError::format(format!(
                    "KIS-NET discovery assigned {qualifier}label {} to conflicting code {} instead of {}.",
                    kind.name, kind.code, owner_code
                )));
            }
        }

        if let Some(canonical_label) = canonical_labels_by_code.get(&kind.code) {
            if canonical_label != &label_key {
                return Err(YtmError::format(format!(
                    "KIS-NET discovery redefined canonical kind code {}.",
                    kind.code
                )));
            }
            continue;
        }

        label_owners.insert(label_key, (kind.code.clone(), false));
        live_only_by_code.insert(kind.code, kind.name);
    }

    check_cancellation(cancellation, "kinds")?;

    for (code, name) in live_only_by_code {
        check_cancellation(cancellation, "kinds")?;
        canonical.push(Kind { code, name });
    }
    Ok(canonical)
}

fn resolve_kind_with_cancellation(
    input: &str,
    kinds: &[Kind],
    cancellation: &CancellationToken,
) -> Result<Option<Kind>, YtmError> {
    let label_key = kind_label_key(input);
    for kind in kinds {
        check_cancellation(cancellation, "matrix")?;
        if kind.code == input || kind_label_key(&kind.name) == label_key {
            return Ok(Some(kind.clone()));
        }
    }
    check_cancellation(cancellation, "matrix")?;
    Ok(None)
}

fn kind_label_key(value: &str) -> String {
    value.split_whitespace().collect()
}

#[cfg(test)]
fn normalize_row(row: IndexMap<String, String>, kind: &Kind) -> Result<MatrixRow, YtmError> {
    normalize_row_with_cancellation(row, kind, &CancellationToken::new())
}

fn normalize_row_with_cancellation(
    row: IndexMap<String, String>,
    kind: &Kind,
    cancellation: &CancellationToken,
) -> Result<MatrixRow, YtmError> {
    check_cancellation(cancellation, "matrix")?;
    for required in ["pricingGroupCode", "pricingGroupName"]
        .into_iter()
        .chain(TENORS.iter().map(|(key, _)| *key))
    {
        if !row.contains_key(required) {
            return Err(YtmError::format(format!(
                "KIS-NET matrix row is missing required column {required}."
            )));
        }
    }
    let pricing_group_code = row["pricingGroupCode"].trim().to_owned();
    let pricing_group_name = row["pricingGroupName"].trim().to_owned();
    if pricing_group_code.is_empty() || pricing_group_name.is_empty() {
        return Err(YtmError::format(
            "KIS-NET matrix row contains an empty pricing group code or name.",
        ));
    }
    let mut yields = IndexMap::new();
    let mut yield_text = IndexMap::new();
    for (key, label) in TENORS {
        check_cancellation(cancellation, "matrix")?;
        let raw = row[key].to_owned();
        let value = if raw.is_empty() || raw == "-" {
            None
        } else {
            // KIS-NET emits fixed-width decimals with leading ASCII spaces.
            // Parse that normalized view while retaining the exact source cell
            // in both `yield_text` and `raw` for provenance.
            let numeric = raw.trim_start_matches(' ');
            if !is_decimal_yield(numeric) {
                return Err(YtmError::format(format!(
                    "KIS-NET matrix column {key} contains an invalid numeric value."
                )));
            }
            Some(numeric.parse::<f64>().map_err(|_| {
                YtmError::format(format!(
                    "KIS-NET matrix column {key} contains an invalid numeric value."
                ))
            })?)
        };
        if value.is_some_and(|number| !number.is_finite()) {
            return Err(YtmError::format(format!(
                "KIS-NET matrix column {key} contains an invalid numeric value."
            )));
        }
        yields.insert(label.to_owned(), value);
        yield_text.insert(label.to_owned(), raw);
    }
    check_cancellation(cancellation, "matrix")?;
    Ok(MatrixRow {
        group_name: kind.name.clone(),
        pricing_group_code,
        pricing_group_name,
        yields,
        yield_text,
        raw: row,
    })
}

fn is_decimal_yield(value: &str) -> bool {
    let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
    let mut parts = unsigned.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some() {
        return false;
    }
    match fraction {
        None => !integer.is_empty() && integer.bytes().all(|byte| byte.is_ascii_digit()),
        Some(fraction) => {
            (!integer.is_empty() || !fraction.is_empty())
                && integer.bytes().all(|byte| byte.is_ascii_digit())
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

fn source_metadata(
    path: &'static str,
    out_datasets: &'static str,
    compact: &str,
    kind: &str,
    workflow: &'static str,
) -> SourceMetadata {
    SourceMetadata {
        page_url: SOURCE_PAGE_URL,
        endpoint: Some(format!("{SOURCE_ORIGIN}{path}")),
        method: Some("POST"),
        request: Some(SourceRequest {
            format: "Nexacro XML PlatformData",
            in_datasets: request::IN_DATASETS,
            out_datasets,
            parameters: SourceParameters {
                cal_base_dt: compact.to_owned(),
                cbo_ytm_sort: kind.to_owned(),
            },
        }),
        inspected_workflow: Some(workflow),
        note: None,
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use async_trait::async_trait;

    use super::*;

    #[derive(Clone)]
    struct EmptyKindsTransport {
        requests: Arc<Mutex<Vec<crate::PreparedRequest>>>,
    }

    #[async_trait]
    impl Transport for EmptyKindsTransport {
        async fn post(
            &self,
            request: crate::PreparedRequest,
            _cancellation: CancellationToken,
        ) -> Result<Vec<u8>, YtmError> {
            self.requests.lock().unwrap().push(request);
            Ok(format!(
                "<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows/></Dataset></Root>",
                namespace = "http://www.nexacroplatform.com/platform/dataset",
            )
            .into_bytes())
        }
    }

    #[derive(Clone)]
    struct CancelAfterTransport {
        response: Vec<u8>,
        cancellation: CancellationToken,
        requests: Arc<Mutex<Vec<crate::PreparedRequest>>>,
    }

    type TestResponse = Result<Vec<u8>, YtmError>;

    #[async_trait]
    impl Transport for CancelAfterTransport {
        async fn post(
            &self,
            request: crate::PreparedRequest,
            _cancellation: CancellationToken,
        ) -> Result<Vec<u8>, YtmError> {
            self.requests.lock().unwrap().push(request);
            self.cancellation.cancel();
            Ok(self.response.clone())
        }
    }

    #[derive(Clone)]
    struct SequenceTransport {
        responses: Arc<Mutex<VecDeque<TestResponse>>>,
        requests: Arc<Mutex<Vec<crate::PreparedRequest>>>,
    }

    #[async_trait]
    impl Transport for SequenceTransport {
        async fn post(
            &self,
            request: crate::PreparedRequest,
            _cancellation: CancellationToken,
        ) -> Result<Vec<u8>, YtmError> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("test transport response")
        }
    }

    fn response(rows: &str) -> Vec<u8> {
        format!(
            "<Root xmlns=\"{namespace}\"><Parameters><Parameter id=\"ErrorCode\">0</Parameter></Parameters><Dataset id=\"output1\"><Rows>{rows}</Rows></Dataset></Root>",
            namespace = "http://www.nexacroplatform.com/platform/dataset",
        )
        .into_bytes()
    }

    fn kind_rows(count: usize) -> String {
        (0..count)
            .map(|index| {
                format!(
                    "<Row><Col id=\"divCode\">{}</Col><Col id=\"divName\">live kind {index}</Col></Row>",
                    90 + index,
                )
            })
            .collect()
    }

    fn canonical_kind_response() -> Vec<u8> {
        response("<Row><Col id=\"divCode\">10</Col><Col id=\"divName\">국채</Col></Row>")
    }

    fn empty_response() -> Vec<u8> {
        response("")
    }

    #[test]
    fn canonical_catalog_includes_private_corporate_bonds() {
        assert_eq!(
            canonical_kinds().last().unwrap(),
            &Kind {
                code: "80".into(),
                name: "회사채(사모)".into()
            }
        );
    }

    #[tokio::test]
    async fn fallback_never_sends_a_date_outside_the_public_domain() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let service = YtmService::with_transport(EmptyKindsTransport {
            requests: requests.clone(),
        });
        let input = MatrixInput::previous_available(
            BaseDate::new(0, 1, 1).unwrap(),
            "국채".parse().unwrap(),
            crate::LookbackDays::new(1).unwrap(),
        );

        let error = service.matrix(input).await.unwrap_err();

        assert_eq!(error.details.code, "invalid_parameter");
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]
            .body
            .contains("<Col id=\"calBaseDt\">00000101</Col>"));
        assert!(!requests[0].body.contains("-0001"));
    }

    #[tokio::test]
    async fn pre_aborted_calls_do_not_start_transport_work() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let service = YtmService::with_transport(EmptyKindsTransport {
            requests: requests.clone(),
        });
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = service
            .kinds_with_cancellation(
                KindsInput::for_date(BaseDate::new(2026, 6, 8).unwrap()),
                cancellation,
            )
            .await
            .unwrap_err();

        assert_eq!(error.details.code, "source_transport_error");
        assert_eq!(error.details.operation_name.as_deref(), Some("kinds"));
        assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
        assert!(!error.details.recoverable);
        assert!(!error.details.retryable);
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_after_transport_cannot_return_large_discovery_success() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let cancellation = CancellationToken::new();
        let service = YtmService::with_transport(CancelAfterTransport {
            response: response(&kind_rows(2_000)),
            cancellation: cancellation.clone(),
            requests: requests.clone(),
        });

        let error = service
            .kinds_with_cancellation(
                KindsInput::for_date(BaseDate::new(2026, 6, 8).unwrap()),
                cancellation,
            )
            .await
            .unwrap_err();

        assert_eq!(error.details.code, "source_transport_error");
        assert_eq!(error.details.operation_name.as_deref(), Some("kinds"));
        assert_eq!(
            error.details.attempted_dates.as_deref(),
            Some(["2026-06-08".to_owned()].as_slice())
        );
        assert_eq!(error.details.lookback_days, Some(0));
        assert_eq!(error.details.cause.as_deref(), Some("AbortError"));
        assert!(!error.details.recoverable);
        assert!(!error.details.retryable);
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn matrix_source_failures_preserve_attempt_history_and_operation_context() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let responses = Arc::new(Mutex::new(VecDeque::from([
            Ok(canonical_kind_response()),
            Ok(empty_response()),
            Ok(canonical_kind_response()),
            Err(YtmError::format("test source shape changed")),
        ])));
        let service = YtmService::with_transport(SequenceTransport {
            responses,
            requests: requests.clone(),
        });
        let input = MatrixInput::previous_available(
            BaseDate::new(2026, 6, 8).unwrap(),
            "국채".parse().unwrap(),
            crate::LookbackDays::new(2).unwrap(),
        );

        let error = service.matrix(input).await.unwrap_err();

        assert_eq!(error.details.code, "source_format_error");
        assert_eq!(error.details.operation_name.as_deref(), Some("matrix"));
        assert_eq!(
            error.details.attempted_dates.as_deref(),
            Some(["2026-06-08".to_owned(), "2026-06-07".to_owned()].as_slice())
        );
        assert_eq!(error.details.lookback_days, Some(2));
        assert!(error.details.reason.contains("test source shape changed"));
        assert_eq!(requests.lock().unwrap().len(), 4);
    }

    #[test]
    fn discovery_cannot_redefine_canonical_kind() {
        let error = merge_kinds(vec![Kind {
            code: "80".into(),
            name: "회사채(무보증)".into(),
        }])
        .unwrap_err();
        assert_eq!(error.details.code, "source_format_error");
    }

    #[test]
    fn discovery_rejects_whitespace_normalized_canonical_label_collisions() {
        let error = merge_kinds(vec![Kind {
            code: "90".into(),
            name: "회사채 (사모)".into(),
        }])
        .unwrap_err();

        assert_eq!(error.details.code, "source_format_error");
        assert!(error.details.reason.contains("instead of 80"));
    }

    #[test]
    fn discovery_coalesces_whitespace_equivalent_canonical_entries() {
        let kinds = merge_kinds(vec![Kind {
            code: "80".into(),
            name: "회사채 (사모)".into(),
        }])
        .unwrap();

        assert_eq!(kinds, canonical_kinds());
    }

    #[test]
    fn discovery_rejects_ambiguous_live_only_labels() {
        let error = merge_kinds(vec![
            Kind {
                code: "90".into(),
                name: "테스트 종류".into(),
            },
            Kind {
                code: "91".into(),
                name: "테스트종류".into(),
            },
        ])
        .unwrap_err();

        assert_eq!(error.details.code, "source_format_error");
        assert!(error.details.reason.contains("instead of 90"));
    }

    #[test]
    fn discovery_appends_live_only_kinds_in_first_seen_order() {
        let kinds = merge_kinds(vec![
            Kind {
                code: "91".into(),
                name: "두번째 코드".into(),
            },
            Kind {
                code: "90".into(),
                name: "첫번째 코드".into(),
            },
            Kind {
                code: "91".into(),
                name: "두번째코드".into(),
            },
        ])
        .unwrap();

        assert_eq!(
            &kinds[canonical_kinds().len()..],
            &[
                Kind {
                    code: "91".into(),
                    name: "두번째 코드".into(),
                },
                Kind {
                    code: "90".into(),
                    name: "첫번째 코드".into(),
                },
            ]
        );
    }

    #[test]
    fn numeric_yield_cells_accept_only_the_contract_decimal_grammar() {
        for value in ["0", "-0", "+1", "1.25", ".5", "-.5", "1.", "+1."] {
            assert!(is_decimal_yield(value), "{value}");
        }
        for value in [
            "", "-", "+", ".", "+.", "1e3", "NaN", "inf", "1.2.3", " 2.5", "2.5 ",
        ] {
            assert!(!is_decimal_yield(value), "{value}");
        }
    }

    #[test]
    fn matrix_rows_accept_leading_ascii_padding_without_losing_provenance() {
        for kind in canonical_kinds() {
            let raw_value = "   2.500";
            let mut row = IndexMap::from([
                ("pricingGroupCode".to_owned(), "100".to_owned()),
                ("pricingGroupName".to_owned(), "국고채권".to_owned()),
            ]);
            for (key, _) in TENORS {
                row.insert((*key).to_owned(), raw_value.to_owned());
            }
            let normalized = normalize_row(row, &kind).unwrap();
            assert_eq!(normalized.yields["3M"], Some(2.5), "{}", kind.code);
            assert_eq!(normalized.yield_text["3M"], raw_value, "{}", kind.code);
            assert_eq!(normalized.raw["m3"], raw_value, "{}", kind.code);
        }
    }

    #[test]
    fn matrix_rows_reject_unapproved_yield_whitespace() {
        let kind = canonical_kinds().into_iter().next().unwrap();
        for value in ["2.5 ", " 2 .5", "\t2.5", "\u{a0}2.5", " -", "   "] {
            let mut row = IndexMap::from([
                ("pricingGroupCode".to_owned(), "100".to_owned()),
                ("pricingGroupName".to_owned(), "국고채권".to_owned()),
            ]);
            for (key, _) in TENORS {
                row.insert((*key).to_owned(), value.to_owned());
            }
            let error = normalize_row(row, &kind).unwrap_err();
            assert_eq!(error.details.code, "source_format_error", "{value}");
        }
    }
}
