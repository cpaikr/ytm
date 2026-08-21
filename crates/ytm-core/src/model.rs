use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatrixInput {
    pub base_date: String,
    pub kind: Value,
    pub fallback: Option<String>,
    pub lookback_days: Option<u8>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KindsInput {
    pub base_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Kind {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub kinds: Vec<Kind>,
    pub tenors: Vec<String>,
    pub fallback: &'static str,
    pub default_lookback_days: u8,
    pub max_lookback_days: u8,
    pub minimum_node_major: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindsResult {
    pub base_date: Option<String>,
    pub kinds: Vec<Kind>,
    pub source: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResult {
    pub base_date: String,
    pub kind: Kind,
    pub tenors: Vec<String>,
    pub rows: Vec<MatrixRow>,
    pub source: Value,
    pub requested_base_date: String,
    pub date_resolution: DateResolution,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateResolution {
    pub mode: String,
    pub requested_base_date: String,
    pub resolved_base_date: String,
    pub used_fallback: bool,
    pub attempted_dates: Vec<String>,
    pub lookback_days: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRow {
    pub group_name: String,
    pub pricing_group_code: String,
    pub pricing_group_name: String,
    pub yields: IndexMap<String, Option<f64>>,
    pub yield_text: IndexMap<String, String>,
    pub raw: IndexMap<String, String>,
}

pub const TENORS: [(&str, &str); 15] = [
    ("m3", "3M"),
    ("m6", "6M"),
    ("m9", "9M"),
    ("y1", "1Y"),
    ("y15a", "1.5Y"),
    ("y2", "2Y"),
    ("y25", "2.5Y"),
    ("y3", "3Y"),
    ("y5", "5Y"),
    ("y7", "7Y"),
    ("y10", "10Y"),
    ("y15", "15Y"),
    ("y20", "20Y"),
    ("y30", "30Y"),
    ("y50", "50Y"),
];

pub fn canonical_kinds() -> Vec<Kind> {
    [
        ("10", "국채"),
        ("20", "지방채"),
        ("30", "특수채"),
        ("40", "통안채"),
        ("50", "은행채"),
        ("60", "기타금융채"),
        ("70", "회사채(무보증)"),
        ("80", "회사채(사모)"),
    ]
    .into_iter()
    .map(|(code, name)| Kind {
        code: code.into(),
        name: name.into(),
    })
    .collect()
}

impl Capabilities {
    pub fn current() -> Self {
        Self {
            kinds: canonical_kinds(),
            tenors: TENORS
                .iter()
                .map(|(_, label)| (*label).to_owned())
                .collect(),
            fallback: "previous-available",
            default_lookback_days: 10,
            max_lookback_days: 31,
            minimum_node_major: 22,
        }
    }
}
