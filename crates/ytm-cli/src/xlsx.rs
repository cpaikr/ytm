use std::{
    fs,
    io::{self, Write},
    path::Path,
};

use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};
use serde_json::json;
use ytm_core::{FallbackMode, SourceMetadata};

use crate::{
    encode_json,
    table::{self, Cell, Table},
    Operation, OperationResult, ProcessOutput,
};

#[derive(Debug)]
pub(super) struct ExportError {
    code: &'static str,
    path: String,
    reason: String,
}

impl ExportError {
    fn io(path: &str, action: &str, error: io::Error) -> Self {
        Self {
            code: if error.kind() == io::ErrorKind::AlreadyExists {
                "output_exists"
            } else {
                "output_write_error"
            },
            path: path.into(),
            reason: format!("Cannot {action} output {path:?}: {error}"),
        }
    }

    pub fn output(self, operation: Operation) -> ProcessOutput {
        ProcessOutput {
            code: 1,
            stdout: encode_json(
                &json!({ "ok": false, "error": {
                    "ok": false, "code": self.code, "operationName": operation.name(),
                    "parameter": "output", "actual": self.path, "reason": self.reason,
                    "recoveryHint": if self.code == "output_exists" {
                        "Choose a new output path or use --overwrite to replace an existing regular file."
                    } else if self.code == "export_error" {
                        "Check that result values fit Excel worksheet and cell limits."
                    } else {
                        "Check the parent directory, permissions, available space, and whether another application has locked the file."
                    },
                    "recoveryAction": "inspect_output", "recoverable": true, "retryable": false
                }}),
                false,
            ),
            stderr: String::new(),
        }
    }
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

pub(super) fn preflight(path: &str, overwrite: bool) -> Result<(), ExportError> {
    let destination = Path::new(path);
    let metadata = fs::metadata(parent(destination))
        .map_err(|error| ExportError::io(path, "inspect parent of", error))?;
    if !metadata.is_dir() {
        return Err(ExportError::io(
            path,
            "use parent of",
            io::Error::other("parent is not a directory"),
        ));
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err(ExportError::io(
                    path,
                    "replace",
                    io::Error::other("destination is not a regular file"),
                ));
            }
            if !overwrite {
                return Err(ExportError::io(
                    path,
                    "create",
                    io::Error::from(io::ErrorKind::AlreadyExists),
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(ExportError::io(path, "inspect", error)),
    }
    Ok(())
}

pub(super) fn export(
    result: &OperationResult,
    path: &str,
    overwrite: bool,
) -> Result<usize, ExportError> {
    let (bytes, rows) = render(result).map_err(|error| ExportError {
        code: "export_error",
        path: path.into(),
        reason: format!("Cannot render Excel workbook: {error}"),
    })?;
    publish(&bytes, path, overwrite)?;
    Ok(rows)
}

fn publish(bytes: &[u8], path: &str, overwrite: bool) -> Result<(), ExportError> {
    stage_and_publish(path, overwrite, |file| file.write_all(bytes))
}

fn stage_and_publish(
    path: &str,
    overwrite: bool,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
) -> Result<(), ExportError> {
    let mut staged = tempfile::Builder::new()
        .prefix(".ytm-")
        .suffix(".tmp")
        .tempfile_in(parent(Path::new(path)))
        .map_err(|error| ExportError::io(path, "stage", error))?;
    write(staged.as_file_mut())
        .and_then(|()| staged.flush())
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| ExportError::io(path, "write staged", error))?;
    // Close the data handle before publication, including on Windows. The owned
    // TempPath removes staging on ordinary failures. Never remove the destination.
    let staged = staged.into_temp_path();
    let published = if overwrite {
        staged.persist(path)
    } else {
        staged.persist_noclobber(path)
    };
    published.map_err(|error| ExportError::io(path, "publish", error.error))
}

fn render(result: &OperationResult) -> Result<(Vec<u8>, usize), XlsxError> {
    let mut workbook = Workbook::new();
    let (name, data, frozen) = match result {
        OperationResult::Matrix(result) => ("Matrix", table::matrix(result), 7),
        OperationResult::Kinds(result) => ("Kinds", table::kinds(result), 0),
    };
    let count = data.rows.len();
    write_table(
        workbook.add_worksheet().set_name(name)?,
        &data,
        frozen,
        false,
    )?;
    write_table(
        workbook.add_worksheet().set_name("Metadata")?,
        &metadata(result),
        0,
        true,
    )?;
    Ok((workbook.save_to_buffer()?, count))
}

fn check_dimensions(rows: usize, columns: usize) -> Result<(), XlsxError> {
    if rows >= 1_048_576 || columns == 0 || columns > 16_384 {
        return Err(XlsxError::RowColumnLimitError);
    }
    Ok(())
}

fn write_table(
    sheet: &mut Worksheet,
    table: &Table,
    frozen: u16,
    metadata: bool,
) -> Result<(), XlsxError> {
    check_dimensions(table.rows.len(), table.columns.len())?;
    let header = Format::new()
        .set_bold()
        .set_font_color("#FFFFFF")
        .set_background_color("#234E70")
        .set_text_wrap();
    let text = Format::new().set_text_wrap();
    let number = Format::new().set_num_format(if metadata { "0" } else { "0.000" });
    for (column, title) in table.columns.iter().enumerate() {
        sheet.write_string_with_format(0, column as u16, title, &header)?;
        let width = if metadata {
            if column == 0 {
                44.0
            } else {
                80.0
            }
        } else if frozen == 0 {
            if column == 0 {
                14.0
            } else {
                32.0
            }
        } else {
            match column {
                0 => 19.0,
                1 => 13.0,
                2 => 14.0,
                3 => 10.0,
                4 => 14.0,
                5 => 18.0,
                6 => 20.0,
                _ => 12.0,
            }
        };
        sheet.set_column_width(column as u16, width)?;
    }
    sheet.set_row_height(0, 32.0)?;
    for (row, cells) in table.rows.iter().enumerate() {
        for (column, cell) in cells.iter().enumerate() {
            let (row, column) = ((row + 1) as u32, column as u16);
            match cell {
                Cell::Empty => {
                    sheet.write_blank(row, column, &number)?;
                }
                Cell::Text(value) => {
                    sheet.write_string_with_format(row, column, value, &text)?;
                }
                Cell::Number(value) => {
                    sheet.write_number_with_format(row, column, *value, &number)?;
                }
                Cell::Boolean(value) => {
                    sheet.write_boolean(row, column, *value)?;
                }
            }
        }
    }
    sheet.set_freeze_panes(1, frozen)?;
    if !metadata {
        sheet.autofilter(
            0,
            0,
            table.rows.len() as u32,
            (table.columns.len() - 1) as u16,
        )?;
    }
    Ok(())
}

fn metadata(result: &OperationResult) -> Table {
    let mut rows = vec![entry("operation", result.operation().name())];
    let source = match result {
        OperationResult::Kinds(result) => {
            rows.push(vec![
                Cell::Text("baseDate".into()),
                result
                    .base_date
                    .map(|date| Cell::Text(date.to_string()))
                    .unwrap_or(Cell::Empty),
            ]);
            &result.source
        }
        OperationResult::Matrix(result) => {
            let resolution = &result.date_resolution;
            rows.extend([
                entry("baseDate", result.base_date.to_string()),
                entry("requestedBaseDate", result.requested_base_date.to_string()),
                entry("kind.code", &result.kind.code),
                entry("kind.name", &result.kind.name),
                entry(
                    "dateResolution.mode",
                    match resolution.mode {
                        FallbackMode::Exact => "exact",
                        FallbackMode::PreviousAvailable => "previous-available",
                    },
                ),
                entry(
                    "dateResolution.resolvedBaseDate",
                    resolution.resolved_base_date.to_string(),
                ),
                vec![
                    Cell::Text("dateResolution.usedFallback".into()),
                    Cell::Boolean(resolution.used_fallback),
                ],
                vec![
                    Cell::Text("dateResolution.lookbackDays".into()),
                    Cell::Number(resolution.lookback_days.into()),
                ],
            ]);
            rows.extend(
                resolution
                    .attempted_dates
                    .iter()
                    .enumerate()
                    .map(|(index, date)| {
                        entry(
                            &format!("dateResolution.attemptedDates[{index}]"),
                            date.to_string(),
                        )
                    }),
            );
            &result.source
        }
    };
    source_rows(&mut rows, source);
    Table {
        columns: vec!["field".into(), "value".into()],
        rows,
    }
}

fn entry(field: &str, value: impl Into<String>) -> Vec<Cell> {
    vec![Cell::Text(field.into()), Cell::Text(value.into())]
}

fn source_rows(rows: &mut Vec<Vec<Cell>>, source: &SourceMetadata) {
    rows.push(entry("source.pageUrl", source.page_url));
    for (field, value) in [
        ("source.endpoint", source.endpoint.as_deref()),
        ("source.method", source.method),
        ("source.inspectedWorkflow", source.inspected_workflow),
        ("source.note", source.note),
    ] {
        if let Some(value) = value {
            rows.push(entry(field, value));
        }
    }
    if let Some(request) = &source.request {
        rows.extend([
            entry("source.request.format", request.format),
            entry("source.request.inDatasets", request.in_datasets),
            entry("source.request.outDatasets", request.out_datasets),
            entry(
                "source.request.parameters.calBaseDt",
                &request.parameters.cal_base_dt,
            ),
            entry(
                "source.request.parameters.cboYtmSort",
                &request.parameters.cbo_ytm_sort,
            ),
        ]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn no_clobber_handles_preflight_race_and_concurrent_publishers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("수익률.xlsx");
        let path = path.to_str().unwrap();
        preflight(path, false).unwrap();
        fs::write(path, b"competing writer").unwrap();
        assert_eq!(
            publish(b"new", path, false).unwrap_err().code,
            "output_exists"
        );
        assert_eq!(fs::read(path).unwrap(), b"competing writer");
        let path = directory.path().join("race.xlsx");
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = [b"one", b"two"]
            .into_iter()
            .map(|bytes| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    publish(bytes, path.to_str().unwrap(), false).is_ok()
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| usize::from(worker.join().unwrap()))
                .sum::<usize>(),
            1
        );
        let bytes = fs::read(path).unwrap();
        assert!(bytes == b"one" || bytes == b"two");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn partial_staging_write_failure_preserves_old_file_and_cleans_temp() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.xlsx");
        fs::write(&path, b"old workbook").unwrap();
        for overwrite in [false, true] {
            let error = stage_and_publish(path.to_str().unwrap(), overwrite, |file| {
                file.write_all(b"partial zip")?;
                Err(io::Error::other(
                    "injected disk failure after partial write",
                ))
            })
            .unwrap_err();
            assert_eq!(error.code, "output_write_error");
            assert!(error.reason.contains("injected disk failure"));
            assert_eq!(fs::read(&path).unwrap(), b"old workbook");
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn replace_and_failed_publication_clean_staging() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.xlsx");
        fs::write(&path, b"old").unwrap();
        publish(b"complete replacement", path.to_str().unwrap(), true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete replacement");
        let blocked = directory.path().join("directory.xlsx");
        fs::create_dir(&blocked).unwrap();
        assert!(publish(b"new", blocked.to_str().unwrap(), true).is_err());
        assert!(blocked.is_dir());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
        assert!(publish(
            b"new",
            directory.path().join("absent/out.xlsx").to_str().unwrap(),
            false
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_rejected_and_raced_links_never_write_the_target() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        let link = directory.path().join("out.xlsx");
        fs::write(&target, b"target bytes").unwrap();
        symlink(&target, &link).unwrap();
        for overwrite in [false, true] {
            assert!(preflight(link.to_str().unwrap(), overwrite).is_err());
        }
        assert!(publish(b"new", link.to_str().unwrap(), false).is_err());
        publish(b"new", link.to_str().unwrap(), true).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"target bytes");
        assert_eq!(fs::read(&link).unwrap(), b"new");
    }

    #[test]
    fn renderer_rejects_limits_and_preserves_existing_file() {
        assert!(check_dimensions(1_048_576, 2).is_err());
        assert!(check_dimensions(0, 16_385).is_err());
        assert!(check_dimensions(1_048_575, 16_384).is_ok());
        let mut sheet = Worksheet::new();
        let table = Table {
            columns: vec!["header".into()],
            rows: vec![vec![Cell::Text("x".repeat(32_768))]],
        };
        assert!(matches!(
            write_table(&mut sheet, &table, 0, false),
            Err(XlsxError::MaxStringLengthExceeded)
        ));
    }

    #[tokio::test]
    async fn empty_kinds_has_headers_and_metadata_and_oversized_export_preserves_old_file() {
        let mut result = ytm_core::YtmService::new()
            .unwrap()
            .kinds(ytm_core::KindsInput::default())
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("old.xlsx");
        fs::write(&path, b"old bytes").unwrap();
        result.kinds[0].name = "x".repeat(32_768);
        assert_eq!(
            export(
                &OperationResult::Kinds(result.clone()),
                path.to_str().unwrap(),
                true
            )
            .unwrap_err()
            .code,
            "export_error"
        );
        assert_eq!(fs::read(&path).unwrap(), b"old bytes");
        result.kinds.clear();
        let (bytes, count) = render(&OperationResult::Kinds(result)).unwrap();
        assert_eq!(count, 0);
        assert!(bytes.starts_with(b"PK\x03\x04"));
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
