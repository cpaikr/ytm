use std::{fmt, num::NonZeroU8, str::FromStr};

use chrono::NaiveDate;
use indexmap::IndexMap;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

pub const DEFAULT_LOOKBACK_DAYS: u8 = 10;
pub const MAX_LOOKBACK_DAYS: u8 = 31;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    InvalidBaseDate,
    EmptyKind,
    InvalidLookbackDays,
}

impl fmt::Display for InputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBaseDate => {
                "base date must be a valid calendar date in YYYY-MM-DD, YYYY.MM.DD, or YYYYMMDD form"
            }
            Self::EmptyKind => "kind must be a nonempty label or source code",
            Self::InvalidLookbackDays => "lookback days must be in the inclusive range 1..=31",
        })
    }
}

impl std::error::Error for InputError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BaseDate(NaiveDate);

impl BaseDate {
    pub fn new(year: i32, month: u32, day: u32) -> Result<Self, InputError> {
        if !(0..=9999).contains(&year) {
            return Err(InputError::InvalidBaseDate);
        }
        NaiveDate::from_ymd_opt(year, month, day)
            .map(Self)
            .ok_or(InputError::InvalidBaseDate)
    }

    pub fn display(self) -> String {
        self.0.format("%Y-%m-%d").to_string()
    }

    pub(crate) fn compact(self) -> String {
        self.0.format("%Y%m%d").to_string()
    }

    pub(crate) fn checked_sub_days(self, days: u64) -> Option<Self> {
        self.0.checked_sub_days(chrono::Days::new(days)).map(Self)
    }
}

impl fmt::Display for BaseDate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0.format("%Y-%m-%d"))
    }
}

impl FromStr for BaseDate {
    type Err = InputError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
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
            return Err(InputError::InvalidBaseDate);
        }
        let compact = trimmed.replace(['-', '.'], "");
        NaiveDate::parse_from_str(&compact, "%Y%m%d")
            .map(Self)
            .map_err(|_| InputError::InvalidBaseDate)
    }
}

impl Serialize for BaseDate {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for BaseDate {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct KindSelector(String);

impl KindSelector {
    pub fn new(value: impl Into<String>) -> Result<Self, InputError> {
        let value = value.into().trim().to_owned();
        if value.is_empty() {
            return Err(InputError::EmptyKind);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for KindSelector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for KindSelector {
    type Err = InputError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct LookbackDays(NonZeroU8);

impl LookbackDays {
    pub fn new(value: u8) -> Result<Self, InputError> {
        NonZeroU8::new(value)
            .filter(|value| value.get() <= MAX_LOOKBACK_DAYS)
            .map(Self)
            .ok_or(InputError::InvalidLookbackDays)
    }

    pub fn get(self) -> u8 {
        self.0.get()
    }
}

impl Default for LookbackDays {
    fn default() -> Self {
        Self(NonZeroU8::new(DEFAULT_LOOKBACK_DAYS).expect("default lookback is nonzero"))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum FallbackPolicy {
    #[default]
    Exact,
    PreviousAvailable(LookbackDays),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatrixInput {
    pub base_date: BaseDate,
    pub kind: KindSelector,
    pub fallback: FallbackPolicy,
}

impl MatrixInput {
    pub fn new(base_date: BaseDate, kind: KindSelector) -> Self {
        Self {
            base_date,
            kind,
            fallback: FallbackPolicy::Exact,
        }
    }

    pub fn previous_available(
        base_date: BaseDate,
        kind: KindSelector,
        lookback_days: LookbackDays,
    ) -> Self {
        Self {
            base_date,
            kind,
            fallback: FallbackPolicy::PreviousAvailable(lookback_days),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KindsInput {
    pub base_date: Option<BaseDate>,
}

impl KindsInput {
    pub fn for_date(base_date: BaseDate) -> Self {
        Self {
            base_date: Some(base_date),
        }
    }
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
    pub fallback: FallbackMode,
    pub default_lookback_days: u8,
    pub max_lookback_days: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindsResult {
    pub base_date: Option<BaseDate>,
    pub kinds: Vec<Kind>,
    pub source: SourceMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixResult {
    pub base_date: BaseDate,
    pub kind: Kind,
    pub tenors: Vec<String>,
    pub rows: Vec<MatrixRow>,
    pub source: SourceMetadata,
    pub requested_base_date: BaseDate,
    pub date_resolution: DateResolution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackMode {
    Exact,
    PreviousAvailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateResolution {
    pub mode: FallbackMode,
    pub requested_base_date: BaseDate,
    pub resolved_base_date: BaseDate,
    pub used_fallback: bool,
    pub attempted_dates: Vec<BaseDate>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub page_url: &'static str,
    pub endpoint: Option<String>,
    pub method: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<SourceRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspected_workflow: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRequest {
    pub format: &'static str,
    pub in_datasets: &'static str,
    pub out_datasets: &'static str,
    pub parameters: SourceParameters,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceParameters {
    pub cal_base_dt: String,
    pub cbo_ytm_sort: String,
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
            fallback: FallbackMode::PreviousAvailable,
            default_lookback_days: DEFAULT_LOOKBACK_DAYS,
            max_lookback_days: MAX_LOOKBACK_DAYS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_date_accepts_only_supported_valid_shapes() {
        for value in ["20260820", "2026-08-20", "2026.08.20"] {
            assert_eq!(value.parse::<BaseDate>().unwrap().to_string(), "2026-08-20");
        }
        for value in ["2026.08-20", "2026-02-30", "2026-0820"] {
            assert_eq!(value.parse::<BaseDate>(), Err(InputError::InvalidBaseDate));
        }
        assert_eq!(BaseDate::new(-1, 1, 1), Err(InputError::InvalidBaseDate));
        assert_eq!(
            BaseDate::new(10_000, 1, 1),
            Err(InputError::InvalidBaseDate)
        );
    }

    #[test]
    fn lookback_days_enforces_the_public_range() {
        assert_eq!(LookbackDays::new(1).unwrap().get(), 1);
        assert_eq!(LookbackDays::new(31).unwrap().get(), 31);
        assert_eq!(LookbackDays::new(0), Err(InputError::InvalidLookbackDays));
        assert_eq!(LookbackDays::new(32), Err(InputError::InvalidLookbackDays));
    }
}
