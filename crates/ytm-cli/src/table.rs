use ytm_core::{KindsResult, MatrixResult};

pub(super) struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

impl Table {
    pub fn render(self, delimiter: char) -> String {
        table(self.columns, self.rows, delimiter)
    }
}

pub(super) fn matrix(result: &MatrixResult) -> Table {
    let mut columns = vec![
        "requestedBaseDate".to_owned(),
        "baseDate".to_owned(),
        "usedFallback".to_owned(),
        "kindCode".to_owned(),
        "kindName".to_owned(),
        "pricingGroupCode".to_owned(),
        "pricingGroupName".to_owned(),
    ];
    columns.extend(result.tenors.iter().cloned());
    let rows = result.rows.iter().map(|row| {
        let mut cells = vec![
            Cell::Text(result.requested_base_date.to_string()),
            Cell::Text(result.base_date.to_string()),
            Cell::Boolean(result.date_resolution.used_fallback),
            Cell::Text(result.kind.code.clone()),
            Cell::Text(result.kind.name.clone()),
            Cell::Text(row.pricing_group_code.clone()),
            Cell::Text(row.pricing_group_name.clone()),
        ];
        cells.extend(result.tenors.iter().map(|tenor| {
            row.yields
                .get(tenor)
                .copied()
                .flatten()
                .map(Cell::Number)
                .unwrap_or(Cell::Empty)
        }));
        cells
    });
    Table {
        columns,
        rows: rows.collect(),
    }
}

pub(super) fn kinds(result: &KindsResult) -> Table {
    let rows = result
        .kinds
        .iter()
        .map(|kind| vec![Cell::Text(kind.code.clone()), Cell::Text(kind.name.clone())]);
    Table {
        columns: vec!["code".to_owned(), "name".to_owned()],
        rows: rows.collect(),
    }
}

#[derive(Debug)]
pub(super) enum Cell {
    Empty,
    Text(String),
    Number(f64),
    Boolean(bool),
}

fn table(
    columns: impl IntoIterator<Item = String>,
    rows: impl IntoIterator<Item = Vec<Cell>>,
    delimiter: char,
) -> String {
    let mut rendered = Vec::new();
    rendered.push(
        columns
            .into_iter()
            .map(|cell| format_cell(&Cell::Text(cell), delimiter))
            .collect::<Vec<_>>()
            .join(&delimiter.to_string()),
    );
    rendered.extend(rows.into_iter().map(|row| {
        row.iter()
            .map(|cell| format_cell(cell, delimiter))
            .collect::<Vec<_>>()
            .join(&delimiter.to_string())
    }));
    format!("{}\n", rendered.join("\n"))
}

pub(super) fn format_cell(value: &Cell, delimiter: char) -> String {
    let (mut text, source_string) = match value {
        Cell::Empty => (String::new(), false),
        Cell::Text(value) => (value.clone(), true),
        Cell::Number(value) => (value.to_string(), false),
        Cell::Boolean(value) => (value.to_string(), false),
    };
    if source_string
        && text
            .chars()
            .next()
            .is_some_and(|value| matches!(value, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        text.insert(0, '\'');
    }
    if delimiter == '\t' {
        return text.replace(['\t', '\r', '\n'], " ");
    }
    if text.contains(['"', ',', '\r', '\n']) {
        return format!("\"{}\"", text.replace('"', "\"\""));
    }
    text
}
