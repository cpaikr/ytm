use std::{ffi::OsString, io::Write, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
    let output = ytm_cli::run(std::env::args_os().collect::<Vec<OsString>>()).await;
    let _ = std::io::stdout().write_all(output.stdout.as_bytes());
    let _ = std::io::stderr().write_all(output.stderr.as_bytes());
    ExitCode::from(output.code)
}
