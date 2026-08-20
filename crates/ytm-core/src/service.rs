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
        let fallback = input.fallback.as_deref().unwrap_or("exact");
        if !matches!(fallback, "exact" | "previous-available") {
            return Err(YtmError::invalid_parameter(
                "matrix",
                "fallback",
                "fallback must be previous-available when provided.",
                json!(fallback),
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
            YtmError::invalid_parameter(
                "matrix",
                "kind",
                format!("Unknown 종류: {kind_input}."),
                json!(kind_input),
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
        let raw = row[key].trim().to_owned();
        let value = if raw.is_empty() || raw == "-" {
            None
        } else {
            Some(raw.parse::<f64>().map_err(|_| {
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

fn normalize_date(value: &str, operation: &str) -> Result<(String, String), YtmError> {
    let trimmed = value.trim();
    let compact = trimmed.replace(['-', '.'], "");
    if compact.len() != 8 || !compact.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(YtmError::invalid_parameter(
            operation,
            "baseDate",
            "baseDate must use YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD.",
            json!(value),
        ));
    }
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
}
