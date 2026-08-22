use std::{env, fs, path::PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePolicy {
    minimum_node_major: u8,
}

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir set"));
    let policy_path = manifest_dir.join("../../native-targets.json");
    println!("cargo:rerun-if-changed={}", policy_path.display());
    let policy: RuntimePolicy = serde_json::from_str(
        &fs::read_to_string(&policy_path).expect("native target policy is readable"),
    )
    .expect("native target policy is valid");
    println!(
        "cargo:rustc-env=YTM_MINIMUM_NODE_MAJOR={}",
        policy.minimum_node_major
    );
    napi_build::setup();
}
