use std::sync::Arc;

use chrono::{Days, NaiveDate};
use indexmap::IndexMap;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    error::YtmError,
    model::{
        canonical_kinds, Capabilities, DateResolution, Kind, KindsInput, KindsResult, MatrixInput,
        MatrixResult, MatrixRow, TENORS,
    },
    nexacro,
    request::{self, INIT_PATH, MATRIX_PATH, SOURCE_ORIGIN, SOURCE_PAGE_URL},
    transport::Transport,
};

pub struct YtmService {
    transport: Arc<dyn Transport>,
}

impl YtmService {
    pub fn new(transport: Arc<dyn Transport>) -> Self {
        Self { transport }
    }

    pub fn capabilities() -> Capabilities {
        Capabilities::current()
    }

    pub async fn kinds(
        &self,
        input: KindsInput,
        cancellation: CancellationToken,
    ) -> Result<KindsResult, YtmError> {
        let Some(base_date) = input.base_date else {
            return Ok(KindsResult {
                base_date: None,
                kinds: canonical_kinds(),
                source: json!({
                    "pageUrl": SOURCE_PAGE_URL,
                    "endpoint": Value::Null,
                    "method": Value::Null,
                    "note": "Canonical 종류 catalog owned by the Rust ytm core. Provide baseDate to merge live discovery."
                }),
            });
        };
        let (_, compact) = normalize_date(&base_date, "kinds")?;
        self.kinds_for_date(&base_date, &compact, cancellation)
            .await
    }

    pub async fn matrix(
        &self,
        input: MatrixInput,
        cancellation: CancellationToken,
    ) -> Result<MatrixResult, YtmError> {
        let (requested_date, _) = normalize_date(&input.base_date, "matrix")?;
        let kind_input = kind_text(&input.kind)?;
        let (fallback, lookback_days) = fallback_policy(&input)?;
        let start = NaiveDate::parse_from_str(&requested_date, "%Y-%m-%d").map_err(|_| {
            YtmError::invalid_parameter(
                "matrix",
                "baseDate",
                "baseDate is invalid.",
                json!(input.base_date),
            )
        })?;
        let mut attempted_dates = Vec::new();
        for offset in 0..=u64::from(lookback_days) {
            let date = start.checked_sub_days(Days::new(offset)).ok_or_else(|| {
                YtmError::invalid_parameter(
                    "matrix",
                    "baseDate",
                    "baseDate fallback underflowed.",
                    json!(requested_date),
                )
            })?;
            let display = date.format("%Y-%m-%d").to_string();
            let compact = date.format("%Y%m%d").to_string();
            attempted_dates.push(display.clone());
            match self
                .matrix_for_date(&display, &compact, &kind_input, cancellation.clone())
                .await
            {
                Ok((kind, rows, source)) => {
                    return Ok(MatrixResult {
                        base_date: display.clone(),
                        requested_base_date: requested_date.clone(),
                        date_resolution: DateResolution {
                            mode: fallback.to_owned(),
                            requested_base_date: requested_date.clone(),
                            resolved_base_date: display.clone(),
                            used_fallback: display != requested_date,
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
                    if error.details.code == "source_data_unavailable"
                        && fallback == "previous-available"
                        && offset < u64::from(lookback_days) => {}
                Err(error) if error.details.code == "source_data_unavailable" => {
                    return Err(YtmError::unavailable(
                        "matrix",
                        &requested_date,
                        Some(&kind_input),
                        attempted_dates,
                        lookback_days,
                        fallback == "previous-available",
                    ));
                }
                Err(error) => return Err(error),
            }
        }
        Err(YtmError::unavailable(
            "matrix",
            &requested_date,
            Some(&kind_input),
            attempted_dates,
            lookback_days,
            fallback == "previous-available",
        ))
    }

    async fn kinds_for_date(
        &self,
        display: &str,
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
                display,
                None,
                vec![display.to_owned()],
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
            base_date: Some(display.to_owned()),
            kinds,
            source: source_metadata(INIT_PATH, "ds_tymSort=output1 ds_list=output2", compact, "10", "The mobile page posts ds_search to /rateInfo/ytmMatrixMobileInitList.do on initial YTM Matrix load."),
        })
    }

    async fn matrix_for_date(
        &self,
        display: &str,
        compact: &str,
        kind_input: &str,
        cancellation: CancellationToken,
    ) -> Result<(Kind, Vec<MatrixRow>, Value), YtmError> {
        let kinds = self
            .kinds_for_date(display, compact, cancellation.clone())
            .await?
            .kinds;
        let kind = resolve_kind(kind_input, &kinds).ok_or_else(|| {
            YtmError::unsupported_kind(
                kind_input,
                json!(kinds),
                json!({
                    "baseDate": display,
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
                display,
                Some(kind_input),
                vec![display.to_owned()],
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

fn fallback_policy(input: &MatrixInput) -> Result<(&str, u8), YtmError> {
    let fallback = input.fallback.as_deref().unwrap_or("exact");
    if !matches!(fallback, "exact" | "previous-available") {
        return Err(YtmError::invalid_parameter(
            "matrix",
            "fallback",
            "fallback must be exact or previous-available.",
            json!(fallback),
        ));
    }
    if fallback != "previous-available" && input.lookback_days.is_some() {
        return Err(YtmError::invalid_parameter(
            "matrix",
            "lookbackDays",
            "lookbackDays only applies when fallback is previous-available.",
            json!(input.lookback_days),
        ));
    }
    let lookback_days = if fallback == "previous-available" {
        input.lookback_days.unwrap_or(10)
    } else {
        0
    };
    if lookback_days > 31 || (fallback == "previous-available" && lookback_days == 0) {
        return Err(YtmError::invalid_parameter(
            "matrix",
            "lookbackDays",
            "lookbackDays must be an integer from 1 to 31.",
            json!(lookback_days),
        ));
    }
    Ok((fallback, lookback_days))
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

fn normalize_date(value: &str, operation: &str) -> Result<(String, String), YtmError> {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    let supported_shape = bytes.len() == 8 && bytes.iter().all(u8::is_ascii_digit)
        || bytes.len() == 10
            && matches!((bytes[4], bytes[7]), (b'-', b'-') | (b'.', b'.'))
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    if !supported_shape {
        return Err(YtmError::invalid_parameter(
            operation,
            "baseDate",
            "baseDate must use YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.",
            json!(value),
        ));
    }
    let compact = trimmed.replace(['-', '.'], "");
    let date = NaiveDate::parse_from_str(&compact, "%Y%m%d").map_err(|_| {
        YtmError::invalid_parameter(
            operation,
            "baseDate",
            "baseDate is not a valid calendar date.",
            json!(value),
        )
    })?;
    Ok((date.format("%Y-%m-%d").to_string(), compact))
}

fn kind_text(value: &Value) -> Result<String, YtmError> {
    let text = match value {
        Value::String(value) => value.trim().to_owned(),
        Value::Number(value) => value.to_string(),
        _ => {
            return Err(YtmError::invalid_parameter(
                "matrix",
                "kind",
                "kind must be a 종류 label or source code.",
                value.clone(),
            ))
        }
    };
    if text.is_empty() {
        return Err(YtmError::invalid_parameter(
            "matrix",
            "kind",
            "kind must be nonempty.",
            value.clone(),
        ));
    }
    Ok(text)
}

fn source_metadata(
    path: &str,
    out_datasets: &str,
    compact: &str,
    kind: &str,
    workflow: &str,
) -> Value {
    json!({
        "pageUrl": SOURCE_PAGE_URL,
        "endpoint": format!("{SOURCE_ORIGIN}{path}"),
        "method": "POST",
        "request": {
            "format": "Nexacro XML PlatformData",
            "inDatasets": request::IN_DATASETS,
            "outDatasets": out_datasets,
            "parameters": { "calBaseDt": compact, "cboYtmSort": kind }
        },
        "inspectedWorkflow": workflow
    })
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
    fn date_normalization_accepts_only_the_documented_shapes() {
        for value in ["20260820", "2026-08-20", "2026.08.20"] {
            assert_eq!(
                normalize_date(value, "matrix").unwrap(),
                ("2026-08-20".into(), "20260820".into())
            );
        }
        for value in ["2026.08-20", "2026-0820", "202608-20", "2026..08.20"] {
            assert_eq!(
                normalize_date(value, "matrix").unwrap_err().details.code,
                "invalid_parameter"
            );
        }
    }

    #[test]
    fn fallback_policy_rejects_lookback_without_previous_available() {
        for fallback in [None, Some("exact".to_owned())] {
            let input = MatrixInput {
                base_date: "2026-08-20".into(),
                kind: json!("10"),
                fallback,
                lookback_days: Some(1),
            };
            let error = fallback_policy(&input).unwrap_err();
            assert_eq!(error.details.code, "invalid_parameter");
            assert_eq!(error.details.parameter.as_deref(), Some("lookbackDays"));
        }

        let input = MatrixInput {
            base_date: "2026-08-20".into(),
            kind: json!("10"),
            fallback: Some("unexpected".into()),
            lookback_days: None,
        };
        let error = fallback_policy(&input).unwrap_err();
        assert_eq!(error.details.parameter.as_deref(), Some("fallback"));
        assert!(error.details.reason.contains("exact or previous-available"));
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
