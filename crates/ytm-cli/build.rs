use std::{env, fs, path::PathBuf};

use serde_json::Value;

fn main() {
    let manifest_path = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"))
        .join("../../cli-targets.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("read cli-targets.json for CLI build identity"),
    )
    .expect("parse cli-targets.json for CLI build identity");
    let rust_target = env::var("TARGET").expect("Cargo TARGET");
    let target = manifest["targets"]
        .as_array()
        .and_then(|targets| {
            targets
                .iter()
                .find(|candidate| candidate["rustTarget"].as_str() == Some(&rust_target))
        })
        .unwrap_or_else(|| panic!("{rust_target} is not declared in cli-targets.json"));

    emit("YTM_CLI_TARGET_KEY", &target["key"]);
    emit("YTM_CLI_EXECUTABLE_FILE", &target["executableFile"]);
    emit("YTM_CLI_REPOSITORY", &manifest["repository"]);
    emit("YTM_CLI_CHECKSUM_FILE", &manifest["checksumFile"]);
    let archive = format!(
        "{}-v{}-{}.{}",
        manifest["assetPrefix"]
            .as_str()
            .expect("assetPrefix string"),
        env::var("CARGO_PKG_VERSION").expect("Cargo package version"),
        target["key"].as_str().expect("target key string"),
        target["archiveFormat"]
            .as_str()
            .expect("target archiveFormat string")
    );
    println!("cargo:rustc-env=YTM_CLI_ARCHIVE_ASSET={archive}");
    let installer = if target["os"].as_str() == Some("win32") {
        &manifest["installerAssets"]["powershell"]
    } else {
        &manifest["installerAssets"]["shell"]
    };
    emit("YTM_CLI_INSTALLER_ASSET", installer);
}

fn emit(name: &str, value: &Value) {
    let value = value
        .as_str()
        .unwrap_or_else(|| panic!("cli-targets.json {name} value must be a string"));
    assert!(
        !value.contains(['\n', '\r', '\0']),
        "cli-targets.json {name} value is unsafe"
    );
    println!("cargo:rustc-env={name}={value}");
}
