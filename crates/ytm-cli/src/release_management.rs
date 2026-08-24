use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use semver::Version;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ProcessOutput;

const TARGET: &str = env!("YTM_CLI_TARGET_KEY");
const EXECUTABLE: &str = env!("YTM_CLI_EXECUTABLE_FILE");
const REPOSITORY: &str = env!("YTM_CLI_REPOSITORY");
const CHECKSUM_ASSET: &str = env!("YTM_CLI_CHECKSUM_FILE");
const INSTALLER_ASSET: &str = env!("YTM_CLI_INSTALLER_ASSET");
const ARCHIVE_ASSET: &str = env!("YTM_CLI_ARCHIVE_ASSET");
const RECEIPT_SCHEMA: &str = "1";
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_INSTALLER_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpgradeMode {
    Check,
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Receipt {
    version: Version,
    target: String,
    executable: String,
    release_source: String,
    installed_sha256: String,
}

#[derive(Debug)]
struct ManagedInstall {
    executable_path: PathBuf,
    receipt_path: PathBuf,
    receipt: Receipt,
    actual_digest: String,
}

#[derive(Debug)]
struct ManagementError {
    code: &'static str,
    reason: String,
    recovery_hint: String,
    recovery_action: &'static str,
    recoverable: bool,
    retryable: bool,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

pub(crate) async fn run(mode: UpgradeMode) -> ProcessOutput {
    match execute(mode).await {
        Ok(value) => output(0, value),
        Err(error) => output(
            1,
            json!({
                "ok": false,
                "error": {
                    "code": error.code,
                    "operationName": "upgrade",
                    "reason": error.reason,
                    "recoveryHint": error.recovery_hint,
                    "recoveryAction": error.recovery_action,
                    "recoverable": error.recoverable,
                    "retryable": error.retryable
                }
            }),
        ),
    }
}

async fn execute(mode: UpgradeMode) -> Result<Value, ManagementError> {
    let install = inspect_managed_install()?;
    let release = fetch_latest_release().await?;
    let latest = release_version(&release)?;
    let source = release_source(&latest);
    let assets = required_assets(&release, &latest)?;
    let archive_asset = archive_asset(&latest);

    if mode == UpgradeMode::Check || latest <= install.receipt.version {
        let status = if latest > install.receipt.version {
            "updateAvailable"
        } else if latest == install.receipt.version {
            "upToDate"
        } else {
            "aheadOfLatest"
        };
        return Ok(json!({
            "ok": true,
            "operationName": "upgrade",
            "status": status,
            "currentVersion": install.receipt.version.to_string(),
            "latestVersion": latest.to_string(),
            "target": TARGET,
            "releaseSource": source,
            "updateAvailable": latest > install.receipt.version
        }));
    }

    let checksums = download(&assets[CHECKSUM_ASSET], MAX_METADATA_BYTES).await?;
    let checksums = parse_checksums(&checksums)?;
    let installer_digest = checksums.get(INSTALLER_ASSET).ok_or_else(|| {
        invalid_release(format!(
            "{CHECKSUM_ASSET} does not contain {INSTALLER_ASSET}."
        ))
    })?;
    let archive_digest = checksums.get(&archive_asset).ok_or_else(|| {
        invalid_release(format!(
            "{CHECKSUM_ASSET} does not contain {archive_asset}."
        ))
    })?;
    let installer = download(&assets[INSTALLER_ASSET], MAX_INSTALLER_BYTES).await?;
    let actual_installer_digest = digest_bytes(&installer);
    if &actual_installer_digest != installer_digest {
        return Err(invalid_release(format!(
            "Checksum mismatch for {INSTALLER_ASSET}: expected {installer_digest}, received {actual_installer_digest}."
        )));
    }
    let installer_text = std::str::from_utf8(&installer)
        .map_err(|_| invalid_release(format!("{INSTALLER_ASSET} is not UTF-8 text.")))?;
    if !installer_text.contains(archive_digest) || !installer_text.contains(&archive_asset) {
        return Err(invalid_release(format!(
            "{INSTALLER_ASSET} does not pin the published digest for {archive_asset}."
        )));
    }

    let release_base = assets[INSTALLER_ASSET]
        .strip_suffix(&format!("/{INSTALLER_ASSET}"))
        .ok_or_else(|| invalid_release(format!("Invalid URL for {INSTALLER_ASSET}.")))?;
    let status = invoke_installer(&installer, release_base, &install, &latest, archive_digest)?;
    if !cfg!(windows) {
        verify_installed_pair(&install.executable_path, &latest)?;
    }

    let mut result = json!({
        "ok": true,
        "operationName": "upgrade",
        "status": status,
        "previousVersion": install.receipt.version.to_string(),
        "version": latest.to_string(),
        "target": TARGET,
        "releaseSource": source
    });
    if cfg!(windows) {
        result["statusPath"] = Value::String(
            install
                .executable_path
                .with_file_name(format!(".{EXECUTABLE}.upgrade-status.json"))
                .display()
                .to_string(),
        );
        result["restartRequired"] = Value::Bool(true);
    }
    Ok(result)
}

fn inspect_managed_install() -> Result<ManagedInstall, ManagementError> {
    let executable_path = std::env::current_exe()
        .map_err(|error| unmanaged(format!("Could not locate the running executable: {error}.")))?;
    inspect_managed_install_at(executable_path)
}

fn inspect_managed_install_at(executable_path: PathBuf) -> Result<ManagedInstall, ManagementError> {
    let metadata = fs::symlink_metadata(&executable_path).map_err(|error| {
        unmanaged(format!(
            "Could not inspect {}: {error}.",
            executable_path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(unmanaged(format!(
            "{} is not a directly managed regular file.",
            executable_path.display()
        )));
    }
    if executable_path.file_name().and_then(|name| name.to_str()) != Some(EXECUTABLE) {
        return Err(unmanaged(format!(
            "The running executable must be named {EXECUTABLE}; found {}.",
            executable_path.display()
        )));
    }
    let receipt_path = receipt_path(&executable_path);
    let receipt_metadata = fs::symlink_metadata(&receipt_path).map_err(|error| {
        unmanaged(format!(
            "Could not inspect the managed-install receipt {}: {error}.",
            receipt_path.display()
        ))
    })?;
    if receipt_metadata.file_type().is_symlink() || !receipt_metadata.is_file() {
        return Err(unmanaged(format!(
            "{} is not a directly managed regular file.",
            receipt_path.display()
        )));
    }
    let receipt_bytes = fs::read(&receipt_path).map_err(|error| {
        unmanaged(format!(
            "Could not read the managed-install receipt {}: {error}.",
            receipt_path.display()
        ))
    })?;
    let receipt = Receipt::parse(&receipt_bytes).map_err(|reason| {
        unmanaged(format!(
            "Invalid managed-install receipt {}: {reason}",
            receipt_path.display()
        ))
    })?;
    validate_receipt_identity(&receipt)?;
    let running =
        Version::parse(env!("CARGO_PKG_VERSION")).expect("Cargo package version is semver");
    if receipt.version != running {
        return Err(recovery_required(
            format!(
                "Receipt version {} does not match running version {}.",
                receipt.version, running
            ),
            &executable_path,
            &receipt_path,
        ));
    }
    let actual_digest = digest_file(&executable_path).map_err(|error| {
        unmanaged(format!(
            "Could not hash {}: {error}.",
            executable_path.display()
        ))
    })?;
    if actual_digest != receipt.installed_sha256 {
        return Err(recovery_required(
            format!(
                "The installed executable digest does not match {}.",
                receipt_path.display()
            ),
            &executable_path,
            &receipt_path,
        ));
    }
    for path in previous_paths(&executable_path, &receipt_path) {
        if path.exists() {
            return Err(recovery_required(
                format!(
                    "An interrupted upgrade left recovery evidence at {}.",
                    path.display()
                ),
                &executable_path,
                &receipt_path,
            ));
        }
    }
    if cfg!(windows) {
        let in_progress = in_progress_path(&executable_path);
        if in_progress.exists() {
            return Err(recovery_required(
                format!(
                    "An unfinished Windows upgrade owns the install through {}.",
                    in_progress.display()
                ),
                &executable_path,
                &receipt_path,
            ));
        }
    }
    Ok(ManagedInstall {
        executable_path,
        receipt_path,
        receipt,
        actual_digest,
    })
}

fn validate_receipt_identity(receipt: &Receipt) -> Result<(), ManagementError> {
    if receipt.target != TARGET || receipt.executable != EXECUTABLE {
        return Err(unmanaged(format!(
            "Receipt identity is {} / {}, but this binary is {} / {}.",
            receipt.target, receipt.executable, TARGET, EXECUTABLE
        )));
    }
    let expected_source = release_source(&receipt.version);
    if receipt.release_source != expected_source {
        return Err(unmanaged(format!(
            "Receipt release source must be {expected_source}; found {}.",
            receipt.release_source
        )));
    }
    Ok(())
}

fn verify_installed_pair(
    executable: &Path,
    expected_version: &Version,
) -> Result<(), ManagementError> {
    let receipt_path = receipt_path(executable);
    let receipt_bytes = fs::read(&receipt_path).map_err(|error| {
        post_install_failure(
            format!(
                "The installer returned success, but {} could not be read: {error}.",
                receipt_path.display()
            ),
            executable,
            &receipt_path,
        )
    })?;
    let receipt = Receipt::parse(&receipt_bytes).map_err(|reason| {
        post_install_failure(
            format!(
                "The installer returned success, but {} is invalid: {reason}",
                receipt_path.display()
            ),
            executable,
            &receipt_path,
        )
    })?;
    if receipt.version != *expected_version
        || receipt.target != TARGET
        || receipt.executable != EXECUTABLE
        || receipt.release_source != release_source(expected_version)
    {
        return Err(post_install_failure(
            format!(
                "The installer returned success, but {} does not describe v{expected_version} for {TARGET}.",
                receipt_path.display()
            ),
            executable,
            &receipt_path,
        ));
    }
    let digest = digest_file(executable).map_err(|error| {
        post_install_failure(
            format!(
                "The installer returned success, but {} could not be hashed: {error}.",
                executable.display()
            ),
            executable,
            &receipt_path,
        )
    })?;
    if digest != receipt.installed_sha256 {
        return Err(post_install_failure(
            "The installer returned success, but the published executable and receipt do not match."
                .into(),
            executable,
            &receipt_path,
        ));
    }
    Ok(())
}

impl Receipt {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let text = std::str::from_utf8(bytes).map_err(|_| "receipt is not UTF-8.".to_string())?;
        if text.contains('\r') || !text.ends_with('\n') {
            return Err("receipt must use canonical LF-terminated lines.".into());
        }
        let mut fields = BTreeMap::new();
        let expected = [
            "schema",
            "version",
            "target",
            "executable",
            "release_source",
            "installed_sha256",
        ];
        for (index, line) in text.lines().enumerate() {
            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| format!("malformed receipt line {line:?}."))?;
            if expected.get(index) != Some(&key) {
                return Err(format!(
                    "receipt field {key:?} is unknown, duplicated, or out of order."
                ));
            }
            if value.is_empty() || fields.insert(key, value).is_some() {
                return Err(format!("empty or duplicate receipt field {key:?}."));
            }
        }
        if fields.len() != expected.len()
            || expected.iter().any(|field| !fields.contains_key(field))
        {
            return Err("receipt does not contain the exact required field set.".into());
        }
        if fields["schema"] != RECEIPT_SCHEMA {
            return Err(format!("unsupported receipt schema {}.", fields["schema"]));
        }
        let installed_sha256 = fields["installed_sha256"].to_string();
        if !valid_digest(&installed_sha256) {
            return Err("installed_sha256 must be a lowercase SHA-256 digest.".into());
        }
        let raw_version = fields["version"];
        let version = Version::parse(raw_version)
            .map_err(|_| "version must be stable semantic version text.".to_string())?;
        if !version.pre.is_empty()
            || !version.build.is_empty()
            || version.to_string() != raw_version
        {
            return Err("version must be canonical stable semantic version text.".into());
        }
        Ok(Self {
            version,
            target: fields["target"].to_string(),
            executable: fields["executable"].to_string(),
            release_source: fields["release_source"].to_string(),
            installed_sha256,
        })
    }

    #[cfg(test)]
    fn encode(&self) -> Vec<u8> {
        format!(
            "schema={RECEIPT_SCHEMA}\nversion={}\ntarget={}\nexecutable={}\nrelease_source={}\ninstalled_sha256={}\n",
            self.version,
            self.target,
            self.executable,
            self.release_source,
            self.installed_sha256
        )
        .into_bytes()
    }
}

async fn fetch_latest_release() -> Result<GithubRelease, ManagementError> {
    let api = format!("https://api.github.com/repos/{REPOSITORY}/releases/latest");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(format!("ytm/{} upgrade", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| network(format!("Could not configure release client: {error}.")))?;
    let body = download_with_client(&client, &api, MAX_METADATA_BYTES).await?;
    serde_json::from_slice(&body)
        .map_err(|error| invalid_release(format!("Latest release metadata is invalid: {error}.")))
}

async fn download(url: &str, limit: usize) -> Result<Vec<u8>, ManagementError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(format!("ytm/{} upgrade", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| network(format!("Could not configure download client: {error}.")))?;
    download_with_client(&client, url, limit).await
}

async fn download_with_client(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
) -> Result<Vec<u8>, ManagementError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| network(format!("Download failed for {url}: {error}.")))?;
    if !response.status().is_success() {
        return Err(network(format!(
            "Download failed for {url} with HTTP {}.",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(invalid_release(format!(
            "{url} exceeds the {limit}-byte limit."
        )));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| network(format!("Download failed for {url}: {error}.")))?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(invalid_release(format!(
                "{url} exceeds the {limit}-byte limit."
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn release_version(release: &GithubRelease) -> Result<Version, ManagementError> {
    if release.draft || release.prerelease {
        return Err(invalid_release(
            "GitHub latest release must be public and stable.".into(),
        ));
    }
    let raw = release.tag_name.strip_prefix('v').ok_or_else(|| {
        invalid_release(format!("Release tag {} must use vX.Y.Z.", release.tag_name))
    })?;
    let version = Version::parse(raw).map_err(|_| {
        invalid_release(format!(
            "Release tag {} is not semantic version text.",
            release.tag_name
        ))
    })?;
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || release.tag_name != format!("v{version}")
    {
        return Err(invalid_release(format!(
            "Release tag {} must be canonical stable vX.Y.Z text.",
            release.tag_name
        )));
    }
    Ok(version)
}

fn required_assets(
    release: &GithubRelease,
    version: &Version,
) -> Result<BTreeMap<String, String>, ManagementError> {
    let expected_archive = archive_asset(version);
    let required = [CHECKSUM_ASSET, INSTALLER_ASSET, expected_archive.as_str()];
    let mut assets = BTreeMap::new();
    for asset in &release.assets {
        if required.contains(&asset.name.as_str()) {
            let expected_url = format!("{}/{}", release_source(version), asset.name);
            if asset.browser_download_url != expected_url {
                return Err(invalid_release(format!(
                    "Release asset {} must use canonical URL {expected_url}.",
                    asset.name
                )));
            }
            if assets
                .insert(asset.name.clone(), asset.browser_download_url.clone())
                .is_some()
            {
                return Err(invalid_release(format!(
                    "Release contains duplicate asset {}.",
                    asset.name
                )));
            }
        }
    }
    for name in required {
        if !assets.contains_key(name) {
            return Err(invalid_release(format!(
                "Release is missing required asset {name}."
            )));
        }
    }
    Ok(assets)
}

fn parse_checksums(bytes: &[u8]) -> Result<BTreeMap<String, String>, ManagementError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| invalid_release(format!("{CHECKSUM_ASSET} is not UTF-8 text.")))?;
    if text.contains('\r') || !text.ends_with('\n') {
        return Err(invalid_release(format!(
            "{CHECKSUM_ASSET} must use canonical LF-terminated lines."
        )));
    }
    let mut result = BTreeMap::new();
    let mut names = BTreeSet::new();
    let mut prior: Option<&str> = None;
    for line in text.lines() {
        let Some((digest, name)) = line.split_once("  ") else {
            return Err(invalid_release(format!("Malformed {CHECKSUM_ASSET} line.")));
        };
        if !valid_digest(digest) || name.is_empty() || name.contains(['/', '\\']) {
            return Err(invalid_release(format!(
                "Malformed {CHECKSUM_ASSET} entry for {name}."
            )));
        }
        if prior.is_some_and(|value| value >= name) || !names.insert(name) {
            return Err(invalid_release(format!(
                "{CHECKSUM_ASSET} entries must be unique and sorted."
            )));
        }
        prior = Some(name);
        result.insert(name.to_string(), digest.to_string());
    }
    Ok(result)
}

fn invoke_installer(
    installer: &[u8],
    release_base: &str,
    install: &ManagedInstall,
    latest: &Version,
    archive_digest: &str,
) -> Result<&'static str, ManagementError> {
    let path = create_temporary_installer(installer)?;
    let install_dir = install
        .executable_path
        .parent()
        .ok_or_else(|| unmanaged("The running executable has no install directory.".into()))?;
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command.arg(&path);
        command
    } else {
        let mut command = Command::new("sh");
        command.arg(&path);
        command
    };
    command
        .env("YTM_MANAGED_UPGRADE", "1")
        .env("YTM_CURRENT_VERSION", install.receipt.version.to_string())
        .env("YTM_CURRENT_SHA256", &install.actual_digest)
        .env("YTM_INSTALL_DIR", install_dir)
        .env("YTM_RELEASE_BASE_URL", release_base)
        .env("YTM_PARENT_PID", std::process::id().to_string())
        .env("YTM_EXPECTED_VERSION", latest.to_string())
        .env("YTM_EXPECTED_ARCHIVE_SHA256", archive_digest);
    let child = command.output();
    let _ = fs::remove_file(&path);
    let child = child.map_err(|error| {
        transaction(
            format!("Could not start the verified {INSTALLER_ASSET}: {error}.",),
            install,
        )
    })?;
    if !child.status.success() {
        let diagnostic = String::from_utf8_lossy(&child.stderr).trim().to_string();
        let diagnostic = if diagnostic.is_empty() {
            String::from_utf8_lossy(&child.stdout).trim().to_string()
        } else {
            diagnostic
        };
        return Err(transaction(
            format!(
                "Verified {INSTALLER_ASSET} failed{}.",
                if diagnostic.is_empty() {
                    String::new()
                } else {
                    format!(": {diagnostic}")
                }
            ),
            install,
        ));
    }
    Ok(if cfg!(windows) {
        "scheduled"
    } else {
        "upgraded"
    })
}

fn create_temporary_installer(bytes: &[u8]) -> Result<PathBuf, ManagementError> {
    let extension = if cfg!(windows) { "ps1" } else { "sh" };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for attempt in 0..32u8 {
        let path = std::env::temp_dir().join(format!(
            "ytm-upgrade-{}-{nonce}-{attempt}.{extension}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|error| {
                    let _ = fs::remove_file(&path);
                    transaction_without_paths(format!(
                        "Could not stage {INSTALLER_ASSET}: {error}."
                    ))
                })?;
                file.sync_all().map_err(|error| {
                    let _ = fs::remove_file(&path);
                    transaction_without_paths(format!(
                        "Could not persist staged {INSTALLER_ASSET}: {error}."
                    ))
                })?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(transaction_without_paths(format!(
                    "Could not create staged {INSTALLER_ASSET}: {error}."
                )))
            }
        }
    }
    Err(transaction_without_paths(format!(
        "Could not allocate a unique staged {INSTALLER_ASSET}."
    )))
}

fn receipt_path(executable: &Path) -> PathBuf {
    executable.with_file_name(format!("{EXECUTABLE}.receipt"))
}

fn previous_paths(executable: &Path, receipt: &Path) -> [PathBuf; 2] {
    [
        executable.with_file_name(format!(".{EXECUTABLE}.previous")),
        receipt.with_file_name(format!(".{EXECUTABLE}.receipt.previous")),
    ]
}

fn in_progress_path(executable: &Path) -> PathBuf {
    executable.with_file_name(format!(".{EXECUTABLE}.upgrade-in-progress"))
}

fn release_source(version: &Version) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/v{version}")
}

fn archive_asset(version: &Version) -> String {
    ARCHIVE_ASSET.replacen(env!("CARGO_PKG_VERSION"), &version.to_string(), 1)
}

fn digest_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(lower_hex(&hasher.finalize()))
}

fn digest_bytes(bytes: &[u8]) -> String {
    lower_hex(&Sha256::digest(bytes))
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn output(code: u8, value: Value) -> ProcessOutput {
    ProcessOutput {
        code,
        stdout: format!(
            "{}\n",
            serde_json::to_string(&value).expect("management output is serializable")
        ),
        stderr: String::new(),
    }
}

fn unmanaged(reason: String) -> ManagementError {
    ManagementError {
        code: "unmanaged_install",
        reason,
        recovery_hint:
            "Install ytm with an official GitHub Release installer before using managed upgrade."
                .into(),
        recovery_action: "install",
        recoverable: true,
        retryable: false,
    }
}

fn recovery_required(reason: String, executable: &Path, receipt: &Path) -> ManagementError {
    let [previous, previous_receipt] = previous_paths(executable, receipt);
    ManagementError {
        code: "recovery_required",
        reason,
        recovery_hint: format!(
            "Preserve and inspect {}, {}, {}, and {}; restore the matching executable and receipt pair before retrying.",
            executable.display(),
            receipt.display(),
            previous.display(),
            previous_receipt.display()
        ),
        recovery_action: "restore_install",
        recoverable: true,
        retryable: false,
    }
}

fn network(reason: String) -> ManagementError {
    ManagementError {
        code: "release_unavailable",
        reason,
        recovery_hint: "Retry after GitHub Releases is reachable; the installed executable and receipt were not changed.".into(),
        recovery_action: "retry",
        recoverable: true,
        retryable: true,
    }
}

fn invalid_release(reason: String) -> ManagementError {
    ManagementError {
        code: "invalid_release",
        reason,
        recovery_hint:
            "Do not install this release. The installed executable and receipt were not changed."
                .into(),
        recovery_action: "wait_for_corrected_release",
        recoverable: true,
        retryable: false,
    }
}

fn transaction(reason: String, install: &ManagedInstall) -> ManagementError {
    ManagementError {
        code: "upgrade_failed",
        reason,
        recovery_hint: format!(
            "Inspect {} and {} plus adjacent .previous files; the installer preserves or restores the last verified pair.",
            install.executable_path.display(),
            install.receipt_path.display()
        ),
        recovery_action: "inspect_install_state",
        recoverable: true,
        retryable: false,
    }
}

fn transaction_without_paths(reason: String) -> ManagementError {
    ManagementError {
        code: "upgrade_failed",
        reason,
        recovery_hint: "The installed executable and receipt were not changed; free temporary storage and retry.".into(),
        recovery_action: "retry",
        recoverable: true,
        retryable: true,
    }
}

fn post_install_failure(reason: String, executable: &Path, receipt: &Path) -> ManagementError {
    let [previous, previous_receipt] = previous_paths(executable, receipt);
    ManagementError {
        code: "recovery_required",
        reason,
        recovery_hint: format!(
            "Preserve and inspect {}, {}, {}, and {}; restore the matching executable and receipt pair before retrying.",
            executable.display(),
            receipt.display(),
            previous.display(),
            previous_receipt.display()
        ),
        recovery_action: "restore_install",
        recoverable: true,
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> Receipt {
        let version = Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
        Receipt {
            release_source: release_source(&version),
            version,
            target: TARGET.into(),
            executable: EXECUTABLE.into(),
            installed_sha256: "a".repeat(64),
        }
    }

    #[test]
    fn receipt_round_trips_only_the_canonical_schema() {
        let expected = receipt();
        assert_eq!(Receipt::parse(&expected.encode()).unwrap(), expected);

        for invalid in [
            expected.encode()[..expected.encode().len() - 1].to_vec(),
            String::from_utf8(expected.encode())
                .unwrap()
                .replace("schema=1\n", "schema=2\n")
                .into_bytes(),
            String::from_utf8(expected.encode())
                .unwrap()
                .replace("target=", "unknown=x\ntarget=")
                .into_bytes(),
            String::from_utf8(expected.encode())
                .unwrap()
                .replace("version=", "version=0.2.0\nversion=")
                .into_bytes(),
            String::from_utf8(expected.encode())
                .unwrap()
                .replace(
                    &format!(
                        "target={}\nexecutable={}\n",
                        expected.target, expected.executable
                    ),
                    &format!(
                        "executable={}\ntarget={}\n",
                        expected.executable, expected.target
                    ),
                )
                .into_bytes(),
            String::from_utf8(expected.encode())
                .unwrap()
                .replace(&"a".repeat(64), &"A".repeat(64))
                .into_bytes(),
        ] {
            assert!(Receipt::parse(&invalid).is_err());
        }
    }

    #[test]
    fn managed_install_inspection_is_read_only() {
        let directory = std::env::temp_dir().join(format!(
            "ytm-receipt-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let executable = directory.join(EXECUTABLE);
        fs::write(&executable, b"managed executable fixture").unwrap();
        let mut receipt = receipt();
        receipt.installed_sha256 = digest_file(&executable).unwrap();
        let receipt_path = receipt_path(&executable);
        fs::write(&receipt_path, receipt.encode()).unwrap();
        let before_executable = fs::read(&executable).unwrap();
        let before_receipt = fs::read(&receipt_path).unwrap();
        let before_entries = fs::read_dir(&directory).unwrap().count();

        let inspected = inspect_managed_install_at(executable.clone()).unwrap();
        assert_eq!(inspected.receipt, receipt);
        assert_eq!(fs::read(&executable).unwrap(), before_executable);
        assert_eq!(fs::read(&receipt_path).unwrap(), before_receipt);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), before_entries);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn checksum_manifest_is_strict_and_sorted() {
        let valid = format!("{}  a\n{}  b\n", "0".repeat(64), "f".repeat(64));
        let parsed = parse_checksums(valid.as_bytes()).unwrap();
        assert_eq!(parsed["a"], "0".repeat(64));
        for invalid in [
            valid.trim_end().as_bytes(),
            format!("{}  b\n{}  a\n", "0".repeat(64), "f".repeat(64)).as_bytes(),
            format!("{} *a\n", "0".repeat(64)).as_bytes(),
        ] {
            assert!(parse_checksums(invalid).is_err());
        }
    }

    #[test]
    fn release_tags_are_public_stable_and_canonical() {
        let release = |tag: &str, draft, prerelease| GithubRelease {
            tag_name: tag.into(),
            draft,
            prerelease,
            assets: vec![],
        };
        assert_eq!(
            release_version(&release("v1.2.3", false, false)).unwrap(),
            Version::new(1, 2, 3)
        );
        for invalid in [
            release("1.2.3", false, false),
            release("v1.2.3-beta.1", false, false),
            release("v1.2.3", true, false),
            release("v1.2.3", false, true),
        ] {
            assert!(release_version(&invalid).is_err());
        }
    }

    #[test]
    fn required_assets_follow_the_discovered_release_version() {
        let version = Version::new(9, 8, 7);
        let archive = archive_asset(&version);
        let source = release_source(&version);
        let release = GithubRelease {
            tag_name: format!("v{version}"),
            draft: false,
            prerelease: false,
            assets: [CHECKSUM_ASSET, INSTALLER_ASSET, archive.as_str()]
                .into_iter()
                .map(|name| GithubAsset {
                    name: name.into(),
                    browser_download_url: format!("{source}/{name}"),
                })
                .collect(),
        };
        let assets = required_assets(&release, &version).unwrap();
        assert!(assets.contains_key(&archive));
        assert!(!assets.contains_key(ARCHIVE_ASSET));

        let mut duplicate = release;
        duplicate.assets.push(GithubAsset {
            name: INSTALLER_ASSET.into(),
            browser_download_url: format!("{source}/{INSTALLER_ASSET}"),
        });
        assert!(required_assets(&duplicate, &version).is_err());

        for hostile_url in [
            format!("http://github.com/{REPOSITORY}/releases/download/v{version}/{CHECKSUM_ASSET}"),
            format!(
                "https://github.com/another/project/releases/download/v{version}/{CHECKSUM_ASSET}"
            ),
            format!("https://github.com/{REPOSITORY}/releases/download/v9.9.9/{CHECKSUM_ASSET}"),
        ] {
            let mut hostile = GithubRelease {
                tag_name: format!("v{version}"),
                draft: false,
                prerelease: false,
                assets: [CHECKSUM_ASSET, INSTALLER_ASSET, archive.as_str()]
                    .into_iter()
                    .map(|name| GithubAsset {
                        name: name.into(),
                        browser_download_url: format!("{source}/{name}"),
                    })
                    .collect(),
            };
            hostile.assets[0].browser_download_url = hostile_url;
            assert!(required_assets(&hostile, &version).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn temporary_installer_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let path = create_temporary_installer(b"#!/bin/sh\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        fs::remove_file(path).unwrap();
    }
}
