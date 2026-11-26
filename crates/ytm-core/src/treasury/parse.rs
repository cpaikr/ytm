//! Strict parser for one Treasury daily par yield curve yearly CSV file.
//!
//! The wire facts live in `contracts/treasury/openapi.yaml`. Unknown headers,
//! malformed cells, foreign years, and duplicate dates fail closed rather than
//! being silently skipped, because a skipped cell would look like missing data.

use std::collections::BTreeMap;

use crate::{BaseDate, YtmError};

use super::TreasuryTenor;

/// Source header label, canonical tenor, and maturity in months, in maturity order.
pub const TENORS: [(&str, &str, f64); 14] = [
    ("1 Mo", "1M", 1.0),
    ("1.5 Month", "1.5M", 1.5),
    ("2 Mo", "2M", 2.0),
    ("3 Mo", "3M", 3.0),
    ("4 Mo", "4M", 4.0),
    ("6 Mo", "6M", 6.0),
    ("1 Yr", "1Y", 12.0),
    ("2 Yr", "2Y", 24.0),
    ("3 Yr", "3Y", 36.0),
    ("5 Yr", "5Y", 60.0),
    ("7 Yr", "7Y", 84.0),
    ("10 Yr", "10Y", 120.0),
    ("20 Yr", "20Y", 240.0),
    ("30 Yr", "30Y", 360.0),
];

/// Confirmed contents of one yearly file. An empty map is confirmed absence.
#[derive(Debug, Clone, Default)]
pub(crate) struct YearFile {
    pub observations: BTreeMap<BaseDate, Vec<TreasuryTenor>>,
}

pub(crate) fn parse_year(body: &[u8], year: u16) -> Result<YearFile, YtmError> {
    let text =
        std::str::from_utf8(body).map_err(|_| format_error(year, "is not valid UTF-8".into()))?;
    // Trailing line breaks carry no rows; interior blank lines remain malformed.
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .trim_end_matches(['\r', '\n']);
    // Treasury returns an empty body for years without published data.
    if text.is_empty() {
        return Ok(YearFile::default());
    }
    let mut lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let header = fields(lines.next().unwrap_or_default())
        .ok_or_else(|| format_error(year, "has a malformed header row".into()))?;
    if header.first().map(String::as_str) != Some("Date") || header.len() < 2 {
        return Err(format_error(
            year,
            "header must start with Date followed by at least one tenor".into(),
        ));
    }
    let mut columns: Vec<(&'static str, &'static str, f64)> = Vec::with_capacity(header.len() - 1);
    for label in &header[1..] {
        let Some(&(label, tenor, months)) = TENORS.iter().find(|(known, ..)| known == label) else {
            return Err(format_error(
                year,
                format!("has unknown tenor header {label:?}"),
            ));
        };
        if columns.iter().any(|(known, ..)| *known == label) {
            return Err(format_error(
                year,
                format!("repeats tenor header {label:?}"),
            ));
        }
        columns.push((label, tenor, months));
    }
    // Stable output order is maturity order, independent of source column order.
    let mut order = (0..columns.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| columns[*left].2.total_cmp(&columns[*right].2));

    let mut file = YearFile::default();
    let mut line_number = 1;
    for line in lines {
        line_number += 1;
        let row = fields(line)
            .ok_or_else(|| format_error(year, format!("row {line_number} is malformed")))?;
        if row.len() != header.len() {
            return Err(format_error(
                year,
                format!(
                    "row {line_number} has {} fields; expected {}",
                    row.len(),
                    header.len()
                ),
            ));
        }
        let date = parse_date(&row[0])
            .ok_or_else(|| format_error(year, format!("row {line_number} has invalid date")))?;
        if date.year() != i32::from(year) {
            return Err(format_error(
                year,
                format!("row {line_number} is dated outside {year}"),
            ));
        }
        let tenors = order
            .iter()
            .map(|&index| {
                let (label, tenor, months) = columns[index];
                let text = &row[index + 1];
                let value = if text.is_empty() {
                    None
                } else {
                    Some(parse_yield(text).ok_or_else(|| {
                        format_error(
                            year,
                            format!("row {line_number} has an invalid {label} yield"),
                        )
                    })?)
                };
                Ok(TreasuryTenor {
                    tenor,
                    label,
                    months,
                    value,
                    yield_text: text.clone(),
                })
            })
            .collect::<Result<Vec<_>, YtmError>>()?;
        if file.observations.insert(date, tenors).is_some() {
            return Err(format_error(
                year,
                format!("repeats date {date} at row {line_number}"),
            ));
        }
    }
    Ok(file)
}

/// RFC 4180 fields without embedded line breaks: unquoted text that contains no
/// quote, or a fully quoted value with doubled quotes.
fn fields(line: &str) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut rest = line;
    loop {
        if let Some(quoted) = rest.strip_prefix('"') {
            let mut value = String::new();
            let mut chars = quoted.char_indices();
            let end = loop {
                let (index, character) = chars.next()?;
                if character != '"' {
                    value.push(character);
                } else if quoted[index + 1..].starts_with('"') {
                    value.push('"');
                    chars.next();
                } else {
                    break index + 1;
                }
            };
            fields.push(value);
            rest = &quoted[end..];
            match rest.strip_prefix(',') {
                Some(next) => rest = next,
                None if rest.is_empty() => return Some(fields),
                None => return None,
            }
        } else {
            let (value, next) = match rest.split_once(',') {
                Some((value, next)) => (value, Some(next)),
                None => (rest, None),
            };
            if value.contains('"') {
                return None;
            }
            fields.push(value.to_owned());
            match next {
                Some(next) => rest = next,
                None => return Some(fields),
            }
        }
    }
}

/// Source dates use zero-padded `MM/DD/YYYY`.
fn parse_date(text: &str) -> Option<BaseDate> {
    let bytes = text.as_bytes();
    if bytes.len() != 10
        || bytes[2] != b'/'
        || bytes[5] != b'/'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit())
    {
        return None;
    }
    BaseDate::new(
        text[6..].parse().ok()?,
        text[..2].parse().ok()?,
        text[3..5].parse().ok()?,
    )
    .ok()
}

/// Percent yields: optional minus sign, digits, and an optional fraction.
fn parse_yield(text: &str) -> Option<f64> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(whole, fraction)| {
            (whole, Some(fraction))
        });
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|part| !digits(part)) {
        return None;
    }
    text.parse().ok().filter(|value: &f64| value.is_finite())
}

fn format_error(year: u16, problem: String) -> YtmError {
    super::retarget(YtmError::format(format!(
        "Treasury yield curve CSV for {year} {problem}."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER_2026: &str = r#"Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr""#;

    fn date(text: &str) -> BaseDate {
        text.parse().unwrap()
    }

    #[test]
    fn parses_current_header_set_in_maturity_order() {
        let body = format!(
            "{HEADER_2026}\n11/25/2026,4.27,4.27,4.30,4.34,4.37,4.44,4.56,4.61,4.64,4.65,4.74,4.85,5.28,5.24\n"
        );
        let file = parse_year(body.as_bytes(), 2026).unwrap();
        let tenors = &file.observations[&date("2026-11-25")];
        assert_eq!(
            tenors.iter().map(|t| t.tenor).collect::<Vec<_>>(),
            TENORS
                .iter()
                .map(|(_, tenor, _)| *tenor)
                .collect::<Vec<_>>()
        );
        assert_eq!(tenors[3].value, Some(4.34));
        assert_eq!(tenors[3].yield_text, "4.34");
        assert_eq!(tenors[1].months, 1.5);
    }

    #[test]
    fn older_header_sets_keep_only_published_columns() {
        let body = "Date,\"1 Mo\",\"3 Mo\",\"6 Mo\",\"1 Yr\",\"2 Yr\",\"3 Yr\",\"5 Yr\",\"7 Yr\",\"10 Yr\",\"20 Yr\"\r\n12/30/2005,4.01,4.08,4.37,4.38,4.41,4.37,4.35,4.36,4.39,4.61\r\n";
        let file = parse_year(body.as_bytes(), 2005).unwrap();
        let tenors = &file.observations[&date("2005-12-30")];
        assert_eq!(tenors.len(), 10);
        assert!(tenors.iter().all(|t| t.tenor != "30Y" && t.tenor != "2M"));
    }

    #[test]
    fn blank_cells_are_null_and_preserve_text() {
        let body = "Date,\"3 Mo\",\"30 Yr\"\n02/08/2006,4.47,\n";
        let file = parse_year(body.as_bytes(), 2006).unwrap();
        let tenors = &file.observations[&date("2006-02-08")];
        assert_eq!(tenors[1].value, None);
        assert_eq!(tenors[1].yield_text, "");
    }

    #[test]
    fn empty_body_and_header_only_are_confirmed_absence() {
        for body in [
            "",
            "\n",
            "Date,\"3 Mo\"\n",
            "\u{feff}Date,\"3 Mo\"",
            "Date,\"3 Mo\"\r\n\r\n",
        ] {
            assert!(parse_year(body.as_bytes(), 1989)
                .unwrap()
                .observations
                .is_empty());
        }
    }

    #[test]
    fn rejects_unknown_duplicate_or_missing_structure() {
        for body in [
            "Date,\"9 Mo\"\n01/02/2025,4.1\n",
            "Date,\"3 Mo\",\"3 Mo\"\n01/02/2025,4.1,4.2\n",
            "When,\"3 Mo\"\n01/02/2025,4.1\n",
            "Date\n01/02/2025\n",
            "Date,\"3 Mo\"\n01/02/2025\n",
            "Date,\"3 Mo\"\n2025-01-02,4.1\n",
            "Date,\"3 Mo\"\n01/02/2024,4.1\n",
            "Date,\"3 Mo\"\n01/02/2025,4.1\n01/02/2025,4.2\n",
            "Date,\"3 Mo\"\n01/02/2025,N/A\n",
            "Date,\"3 Mo\"\n01/02/2025, 4.1\n",
            "Date,\"3 Mo\"\n01/02/2025,4.\n",
            "Date,\"3 Mo\"\n\n01/02/2025,4.1\n",
            "Date,\"3 Mo\n01/02/2025,4.1\n",
        ] {
            let error = parse_year(body.as_bytes(), 2025).unwrap_err();
            assert_eq!(error.details.code, "source_format_error", "{body:?}");
            assert!(error.details.reason.starts_with("Treasury"), "{body:?}");
        }
        assert!(parse_year(&[0xff], 2025).is_err());
    }

    #[test]
    fn accepts_negative_and_quoted_values() {
        let body = "Date,\"3 Mo\",\"6 Mo\"\n01/02/2025,-0.02,\"0.10\"\n";
        let file = parse_year(body.as_bytes(), 2025).unwrap();
        let tenors = &file.observations[&date("2025-01-02")];
        assert_eq!(tenors[0].value, Some(-0.02));
        assert_eq!(tenors[1].value, Some(0.1));
    }
}
