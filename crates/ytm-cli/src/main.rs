use std::{ffi::OsString, io::Write, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
    let output = ytm_cli::run(std::env::args_os().collect::<Vec<OsString>>()).await;
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    ExitCode::from(write_output(&output, &mut stdout, &mut stderr))
}

fn write_output(
    output: &ytm_cli::ProcessOutput,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> u8 {
    let stdout_result = stdout
        .write_all(output.stdout.as_bytes())
        .and_then(|()| stdout.flush());
    let stderr_result = stderr
        .write_all(output.stderr.as_bytes())
        .and_then(|()| stderr.flush());
    if stdout_result.is_err() || stderr_result.is_err() {
        1
    } else {
        output.code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("write failed"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct FlushFailingWriter(Vec<u8>);

    impl Write for FlushFailingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("flush failed"))
        }
    }

    #[tokio::test]
    async fn stdout_failure_does_not_remove_a_published_workbook() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("kinds.xlsx");
        let output = ytm_cli::run(vec![
            "ytm".into(),
            "kinds".into(),
            "--format=xlsx".into(),
            "--output".into(),
            path.as_os_str().to_owned(),
        ])
        .await;
        assert_eq!(output.code, 0);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"PK\x03\x04"));
        assert_eq!(
            write_output(&output, &mut FailingWriter, &mut Vec::new()),
            1
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn output_writes_preserve_or_override_the_process_code() {
        let output = ytm_cli::ProcessOutput {
            code: 2,
            stdout: "result".into(),
            stderr: "diagnostic".into(),
        };
        assert_eq!(write_output(&output, &mut Vec::new(), &mut Vec::new()), 2);
        assert_eq!(
            write_output(&output, &mut FailingWriter, &mut Vec::new()),
            1
        );
        assert_eq!(
            write_output(
                &output,
                &mut FlushFailingWriter(Vec::new()),
                &mut Vec::new()
            ),
            1
        );
    }
}
