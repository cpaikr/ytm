use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::json;

use crate::{
    error::YtmError,
    model::{
        canonical_kinds, BaseDate, Capabilities, DateResolution, FallbackMode, FallbackPolicy,
        Kind, KindsInput, KindsResult, MatrixInput, MatrixResult, MatrixRow, SourceMetadata,
        SourceParameters, SourceRequest, TENORS,
    },
    nexacro,
    request::{self, INIT_PATH, MATRIX_PATH, SOURCE_ORIGIN, SOURCE_PAGE_URL},
    transport::{HttpTransport, Transport},
    CancellationToken,
};

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
        let Some(base_date) = input.base_date else {
            return Ok(KindsResult {
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
            });
        };
        let compact = base_date.compact();
        self.kinds_for_date(base_date, &compact, cancellation).await
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
            let date = requested_date.checked_sub_days(offset).ok_or_else(|| {
                YtmError::invalid_parameter(
                    "matrix",
                    "baseDate",
                    "baseDate fallback underflowed.",
                    json!(requested_date),
                )
            })?;
            let compact = date.compact();
            attempted_dates.push(date);
            match self
                .matrix_for_date(date, &compact, &kind_input, cancellation.clone())
                .await
            {
                Ok((kind, rows, source)) => {
                    return Ok(MatrixResult {
                        base_date: date,
                        requested_base_date: requested_date,
                        date_resolution: DateResolution {
                            mode: fallback,
                            requested_base_date: requested_date,
                            resolved_base_date: date,
                            used_fallback: date != requested_date,
                            attempted_dates,
                            lookback_days,
                        },
                        kind,
                        tenors: TENORS
                            .iter()
                            .map(|(_, label)| (*label).to_owned())
                            .collect(),
                        rows,
                        source,
                    });
                }
                Err(error)
                    if error.is_unavailable()
                        && fallback == FallbackMode::PreviousAvailable
                        && offset < u64::from(lookback_days) => {}
                Err(error) if error.is_unavailable() => {
                    return Err(YtmError::unavailable(
                        "matrix",
                        &requested_date.to_string(),
                        Some(&kind_input),
                        attempted_dates.iter().map(ToString::to_string).collect(),
                        lookback_days,
                        fallback == FallbackMode::PreviousAvailable,
                    ));
                }
                Err(error) => return Err(error),
            }
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

    async fn kinds_for_date(
        &self,
        display: BaseDate,
        compact: &str,
        cancellation: CancellationToken,
    ) -> Result<KindsResult, YtmError> {
        let response = self
            .transport
            .post(request::init(compact), cancellation)
            .await?;
        let dataset = nexacro::parse(&response, "output1")?;
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
        let discovered = dataset
            .rows
            .into_iter()
            .map(kind_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let kinds = merge_kinds(discovered)?;
        Ok(KindsResult {
            base_date: Some(display),
            kinds,
            source: source_metadata(INIT_PATH, "ds_tymSort=output1 ds_list=output2", compact, "10", "The mobile page posts ds_search to /rateInfo/ytmMatrixMobileInitList.do on initial YTM Matrix load."),
        })
    }

    async fn matrix_for_date(
        &self,
        display: BaseDate,
        compact: &str,
        kind_input: &str,
        cancellation: CancellationToken,
    ) -> Result<(Kind, Vec<MatrixRow>, SourceMetadata), YtmError> {
        let kinds = self
            .kinds_for_date(display, compact, cancellation.clone())
            .await?
            .kinds;
        let kind = resolve_kind(kind_input, &kinds).ok_or_else(|| {
            YtmError::unsupported_kind(
                kind_input,
                json!(kinds),
                json!({
                    "baseDate": display.to_string(),
                    "kind": kinds.first().map(|kind| kind.name.as_str()).unwrap_or("국채")
                }),
            )
        })?;
        let response = self
            .transport
            .post(request::matrix(compact, &kind.code), cancellation)
            .await?;
        let dataset = nexacro::parse(&response, "output1")?;
        if dataset.rows.is_empty() {
            return Err(YtmError::unavailable(
                "matrix",
                &display.to_string(),
                Some(kind_input),
                vec![display.to_string()],
                0,
                false,
            ));
        }
        let rows = dataset
            .rows
            .into_iter()
            .map(|row| normalize_row(row, &kind))
            .collect::<Result<Vec<_>, _>>()?;
        let source = source_metadata(
            MATRIX_PATH,
            "ds_list=output1",
            compact,
            &kind.code,
            "The mobile page posts ds_search to /rateInfo/ytmMatrixMobileList.do when 검색 is clicked.",
        );
        Ok((kind, rows, source))
    }
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

fn merge_kinds(discovered: Vec<Kind>) -> Result<Vec<Kind>, YtmError> {
    let canonical = canonical_kinds();
    let mut live_by_code = IndexMap::<String, String>::new();
    for kind in discovered {
        if let Some(previous) = live_by_code.get(&kind.code) {
            if previous != &kind.name {
                return Err(YtmError::format(format!(
                    "KIS-NET discovery returned conflicting labels for kind code {}.",
                    kind.code
                )));
            }
            continue;
        }
        if let Some(owner) = canonical
            .iter()
            .find(|candidate| candidate.name == kind.name && candidate.code != kind.code)
        {
            return Err(YtmError::format(format!("KIS-NET discovery assigned canonical label {} to conflicting code {} instead of {}.", kind.name, kind.code, owner.code)));
        }
        live_by_code.insert(kind.code, kind.name);
    }
    for kind in &canonical {
        if let Some(live_name) = live_by_code.get(&kind.code) {
            if live_name != &kind.name {
                return Err(YtmError::format(format!(
                    "KIS-NET discovery redefined canonical kind code {}.",
                    kind.code
                )));
            }
        }
    }
    let mut merged = canonical;
    for (code, name) in live_by_code {
        if !merged.iter().any(|kind| kind.code == code) {
            merged.push(Kind { code, name });
        }
    }
    Ok(merged)
}

fn resolve_kind(input: &str, kinds: &[Kind]) -> Option<Kind> {
    let compact = input.split_whitespace().collect::<String>();
    kinds
        .iter()
        .find(|kind| {
            kind.code == input
                || kind.name == input
                || kind.name.split_whitespace().collect::<String>() == compact
        })
        .cloned()
}

fn normalize_row(row: IndexMap<String, String>, kind: &Kind) -> Result<MatrixRow, YtmError> {
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
    use super::*;

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
