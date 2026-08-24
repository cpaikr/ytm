import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArchiveName, cliArchiveRoot, loadCliReleasePolicy, releaseBaseUrl } from "./cli-release-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(process.argv[2] || "");
  if (!process.argv[2]) throw new Error("Usage: node scripts/generate-cli-installers.mjs <output-directory>");
  const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
  const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
  const digests = new Map();
  for (const target of manifest.targets) {
    const archive = cliArchiveName(manifest, target, version);
    const sidecar = await readFile(resolve(outputDirectory, `${archive}.sha256`), "utf8");
    const match = /^([0-9a-f]{64})  (\S+)\n$/.exec(sidecar);
    if (!match || match[2] !== archive) throw new Error(`Invalid checksum sidecar for ${archive}.`);
    digests.set(archive, match[1]);
  }
  await mkdir(outputDirectory, { recursive: true });
  const shell = generateShellInstaller(manifest, version, digests, linuxBuild);
  const powershell = generatePowerShellInstaller(manifest, version, digests);
  await Promise.all([
    writeFile(resolve(outputDirectory, manifest.installerAssets.shell), shell, { mode: 0o755 }),
    writeFile(resolve(outputDirectory, manifest.installerAssets.powershell), powershell, "utf8")
  ]);
  console.log(`generated ${manifest.installerAssets.shell} and ${manifest.installerAssets.powershell} for v${version}`);
}

export function generateShellInstaller(manifest, version, digests, linuxBuild) {
  const glibcFloor = /^(\d+)\.(\d+)$/.exec(linuxBuild?.glibcFloor || "");
  if (!glibcFloor) throw new Error("Shell installer requires the shared glibc floor.");
  const cases = manifest.targets.filter((target) => target.shellKernel).flatMap((target) =>
    target.shellMachines.map((machine) => {
      const archive = cliArchiveName(manifest, target, version);
      const root = cliArchiveRoot(manifest, target, version);
      return `  ${target.shellKernel}:${machine}) target='${target.key}'; archive='${archive}'; root='${root}'; expected='${requiredDigest(digests, archive)}' ;;`;
    })
  ).join("\n");
  return `#!/bin/sh
set -eu

version='${version}'
repository='${manifest.repository}'
release_base=\${YTM_RELEASE_BASE_URL:-'${releaseBaseUrl(manifest, version)}'}
install_dir=\${YTM_INSTALL_DIR:-"\${HOME}/.local/bin"}
platform="$(uname -s):$(uname -m)"
case "$platform" in
${cases}
  *) printf '%s\\n' "ytm v$version does not support $platform" >&2; exit 1 ;;
esac
if [ "$(uname -s)" = 'Linux' ]; then
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  case "$libc" in glibc\\ *) ;; *) printf '%s\\n' 'ytm supports GNU/Linux with glibc ${linuxBuild.glibcFloor} or newer; this system is not glibc' >&2; exit 1 ;; esac
  libc_version=\${libc#glibc }
  libc_major=\${libc_version%%.*}
  libc_minor=\${libc_version#*.}
  libc_minor=\${libc_minor%%.*}
  case "$libc_major:$libc_minor" in *[!0-9:]*|:*) printf '%s\\n' "could not parse glibc version $libc_version" >&2; exit 1 ;; esac
  if [ "$libc_major" -lt '${glibcFloor[1]}' ] || { [ "$libc_major" -eq '${glibcFloor[1]}' ] && [ "$libc_minor" -lt '${glibcFloor[2]}' ]; }; then
    printf '%s\\n' "ytm requires glibc ${linuxBuild.glibcFloor} or newer; found $libc_version" >&2
    exit 1
  fi
fi

tmp="$(mktemp -d "\${TMPDIR:-/tmp}/ytm-install.XXXXXXXX")"
staged=''
staged_receipt=''
have_backup='0'
fresh_install='0'
executable="$install_dir/ytm"
receipt="$install_dir/ytm.receipt"
previous="$install_dir/.ytm.previous"
previous_receipt="$install_dir/.ytm.receipt.previous"
same_file() {
  [ -e "$1" ] && [ -e "$2" ] || return 1
  first_inode="$(LC_ALL=C ls -id "$1" 2>/dev/null | awk '{print $1}')"
  second_inode="$(LC_ALL=C ls -id "$2" 2>/dev/null | awk '{print $1}')"
  [ -n "$first_inode" ] && [ "$first_inode" = "$second_inode" ]
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$have_backup" = '1' ]; then
    set +e
    restored='1'
    rm -f "$executable" "$receipt" || restored='0'
    mv -f "$previous" "$executable" || restored='0'
    mv -f "$previous_receipt" "$receipt" || restored='0'
    if [ "$restored" = '0' ]; then
      printf '%s\\n' "automatic rollback was incomplete; preserve $executable, $receipt, $previous, and $previous_receipt" >&2
    fi
  fi
  if [ "$fresh_install" = '1' ] && [ -n "$staged" ] && same_file "$executable" "$staged"; then
    if ! { [ -n "$staged_receipt" ] && same_file "$receipt" "$staged_receipt"; }; then
      rm -f "$executable" || printf '%s\\n' "fresh installation was interrupted; preserve the uncommitted executable at $executable" >&2
    fi
  fi
  rm -rf "$tmp"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
  if [ -n "$staged_receipt" ]; then rm -f "$staged_receipt"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
download() {
  if command -v curl >/dev/null 2>&1; then curl --connect-timeout 10 --max-time 120 --fail --location --silent --show-error "$1" --output "$2"
  elif command -v wget >/dev/null 2>&1; then wget --timeout=30 --tries=2 -q "$1" -O "$2"
  else printf '%s\\n' 'ytm installer requires curl or wget' >&2; exit 1
  fi
}
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else printf '%s\\n' 'ytm installer requires sha256sum or shasum' >&2; exit 1
  fi
}
write_receipt() {
  receipt_path=$1
  receipt_version=$2
  receipt_digest=$3
  printf 'schema=1\\nversion=%s\\ntarget=%s\\nexecutable=ytm\\nrelease_source=https://github.com/%s/releases/download/v%s\\ninstalled_sha256=%s\\n' \\
    "$receipt_version" "$target" "$repository" "$receipt_version" "$receipt_digest" > "$receipt_path"
}
download "$release_base/$archive" "$tmp/$archive"
actual="$(hash_file "$tmp/$archive")"
[ "$actual" = "$expected" ] || { printf '%s\\n' "checksum mismatch for $archive" >&2; exit 1; }
tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/$root/ytm" ] || { printf '%s\\n' 'archive does not contain ytm' >&2; exit 1; }
mkdir -p "$install_dir"
staged="$(mktemp "$install_dir/.ytm.install.XXXXXXXX")"
staged_receipt="$(mktemp "$install_dir/.ytm.receipt.install.XXXXXXXX")"
cp "$tmp/$root/ytm" "$staged"
chmod 755 "$staged"
binary_digest="$(hash_file "$staged")"
write_receipt "$staged_receipt" "$version" "$binary_digest"
write_receipt "$tmp/new.receipt" "$version" "$binary_digest"

if [ "\${YTM_MANAGED_UPGRADE:-}" = '1' ]; then
  [ "\${YTM_EXPECTED_VERSION:-}" = "$version" ] || { printf '%s\\n' 'verified installer version does not match the requested upgrade' >&2; exit 1; }
  [ "\${YTM_EXPECTED_ARCHIVE_SHA256:-}" = "$expected" ] || { printf '%s\\n' 'verified installer archive digest does not match the requested upgrade' >&2; exit 1; }
  current_version=\${YTM_CURRENT_VERSION:-}
  current_digest=\${YTM_CURRENT_SHA256:-}
  [ -n "$current_version" ] && [ -n "$current_digest" ] || { printf '%s\\n' 'managed upgrade requires current version and digest identity' >&2; exit 1; }
  [ -f "$executable" ] && [ ! -L "$executable" ] || { printf '%s\\n' "$executable is not a directly managed regular file" >&2; exit 1; }
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || { printf '%s\\n' "$receipt is not a directly managed regular file" >&2; exit 1; }
  [ "$(hash_file "$executable")" = "$current_digest" ] || { printf '%s\\n' "$executable changed after upgrade validation" >&2; exit 1; }
  write_receipt "$tmp/current.receipt" "$current_version" "$current_digest"
  cmp -s "$tmp/current.receipt" "$receipt" || { printf '%s\\n' "$receipt changed after upgrade validation" >&2; exit 1; }
  if [ -e "$previous" ] || [ -e "$previous_receipt" ]; then
    printf '%s\\n' "interrupted upgrade evidence exists at $previous or $previous_receipt; preserve it and restore the verified pair before retrying" >&2
    exit 1
  fi
  ln "$executable" "$previous" || { printf '%s\\n' "could not preserve $executable at $previous" >&2; exit 1; }
  if ! ln "$receipt" "$previous_receipt"; then
    rm -f "$previous"
    printf '%s\\n' "could not preserve $receipt at $previous_receipt" >&2
    exit 1
  fi
  have_backup='1'
  mv -f "$staged" "$executable"
  staged=''
  mv -f "$staged_receipt" "$receipt"
  staged_receipt=''
  [ "$(hash_file "$executable")" = "$binary_digest" ] || { printf '%s\\n' "replacement digest verification failed for $executable" >&2; exit 1; }
  cmp -s "$tmp/new.receipt" "$receipt" || { printf '%s\\n' "replacement receipt verification failed for $receipt" >&2; exit 1; }
  have_backup='0'
  rm -f "$previous" "$previous_receipt"
  printf '%s\\n' "upgraded ytm from v$current_version to v$version at $executable"
else
  fresh_install='1'
  if [ -e "$previous" ] || [ -e "$previous_receipt" ]; then
    printf '%s\\n' "interrupted upgrade evidence exists at $previous or $previous_receipt; preserve it and restore the verified pair before installing" >&2
    exit 1
  fi
  [ ! -e "$executable" ] && [ ! -e "$receipt" ] || { printf '%s\\n' "$executable or $receipt already exists; installation did not replace it" >&2; exit 1; }
  ln "$staged" "$executable" || { printf '%s\\n' "$executable already exists; installation did not replace it" >&2; exit 1; }
  if ! ln "$staged_receipt" "$receipt"; then
    if ! rm -f "$executable"; then
      printf '%s\\n' "receipt publication failed and $executable could not be removed; preserve it as an uncommitted install" >&2
    fi
    printf '%s\\n' "$receipt already exists; installation did not publish a receipt" >&2
    exit 1
  fi
  rm -f "$staged" "$staged_receipt"
  staged=''
  staged_receipt=''
  printf '%s\\n' "installed ytm v$version to $executable"
fi
`;
}

export function generatePowerShellInstaller(manifest, version, digests) {
  const target = manifest.targets.find((candidate) => candidate.os === "win32" && candidate.arch === "x64");
  if (!target) throw new Error("PowerShell installer requires a Windows x64 target.");
  const archive = cliArchiveName(manifest, target, version);
  const root = cliArchiveRoot(manifest, target, version);
  const expected = requiredDigest(digests, archive);
  return `# Generated from cli-targets.json. Do not edit.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Version = '${version}'
$Target = '${target.key}'
$Repository = '${manifest.repository}'
$ReleaseBase = if ($env:YTM_RELEASE_BASE_URL) { $env:YTM_RELEASE_BASE_URL } else { '${releaseBaseUrl(manifest, version)}' }
if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) { throw "ytm v$Version supports Windows x64 only" }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw "ytm v$Version supports Windows x64 only" }
$InstallDir = if ($env:YTM_INSTALL_DIR) { $env:YTM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ytm\\bin' }
$Archive = '${archive}'
$Expected = '${expected}'
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('ytm-install-' + [Guid]::NewGuid().ToString('N'))
$Staged = $null
$StagedReceipt = $null
$Helper = $null
$HelperProcess = $null
$InProgressOwned = $false
$StatusOwned = $false
$FreshInstall = $false
$FreshExecutablePublished = $false
$FreshCommitted = $false
$FreshStagedPath = $null
$Executable = Join-Path $InstallDir 'ytm.exe'
$Receipt = Join-Path $InstallDir 'ytm.exe.receipt'
$Previous = Join-Path $InstallDir '.ytm.exe.previous'
$PreviousReceipt = Join-Path $InstallDir '.ytm.exe.receipt.previous'
$Status = Join-Path $InstallDir '.ytm.exe.upgrade-status.json'
$InProgress = Join-Path $InstallDir '.ytm.exe.upgrade-in-progress'
function Receipt-Text([string]$ReceiptVersion, [string]$Digest) {
  return "schema=1\`nversion=$ReceiptVersion\`ntarget=$Target\`nexecutable=ytm.exe\`nrelease_source=https://github.com/$Repository/releases/download/v$ReceiptVersion\`ninstalled_sha256=$Digest\`n"
}
function Write-Receipt([string]$Path, [string]$ReceiptVersion, [string]$Digest) {
  [IO.File]::WriteAllText($Path, (Receipt-Text $ReceiptVersion $Digest), [Text.UTF8Encoding]::new($false))
}
function Write-Status([string]$Path, [string]$Json) {
  $StatusTemp = $Path + '.write.' + [Guid]::NewGuid().ToString('N')
  try {
    [IO.File]::WriteAllText($StatusTemp, $Json, [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($StatusTemp, $Path, $null) }
    else { [IO.File]::Move($StatusTemp, $Path) }
  } finally {
    if ([IO.File]::Exists($StatusTemp)) { [IO.File]::Delete($StatusTemp) }
  }
}
function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "$ReleaseBase/$Archive" -OutFile (Join-Path $Temp $Archive)
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temp $Archive)).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "checksum mismatch for $Archive" }
  Expand-Archive -LiteralPath (Join-Path $Temp $Archive) -DestinationPath $Temp
  $Root = '${root}'
  $Binary = Join-Path (Join-Path $Temp $Root) 'ytm.exe'
  if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw 'archive does not contain ytm.exe' }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Staged = Join-Path $InstallDir ('.ytm.install.' + [Guid]::NewGuid().ToString('N') + '.exe')
  $StagedReceipt = Join-Path $InstallDir ('.ytm.receipt.install.' + [Guid]::NewGuid().ToString('N'))
  Copy-Item -LiteralPath $Binary -Destination $Staged
  $BinaryDigest = (Get-FileHash -Algorithm SHA256 $Staged).Hash.ToLowerInvariant()
  Write-Receipt $StagedReceipt $Version $BinaryDigest
  $ReceiptDigest = (Get-FileHash -Algorithm SHA256 $StagedReceipt).Hash.ToLowerInvariant()

  if ($env:YTM_MANAGED_UPGRADE -eq '1') {
    if ($env:YTM_EXPECTED_VERSION -ne $Version) { throw 'verified installer version does not match the requested upgrade' }
    if ($env:YTM_EXPECTED_ARCHIVE_SHA256 -ne $Expected) { throw 'verified installer archive digest does not match the requested upgrade' }
    if (-not $env:YTM_CURRENT_VERSION -or -not $env:YTM_CURRENT_SHA256 -or -not $env:YTM_PARENT_PID) { throw 'managed upgrade requires current version, digest, and parent process identity' }
    $ParentProcess = Get-Process -Id ([int]$env:YTM_PARENT_PID) -ErrorAction Stop
    $ParentStartTicks = $ParentProcess.StartTime.ToUniversalTime().Ticks.ToString()
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or -not (Test-Path -LiteralPath $Receipt -PathType Leaf)) { throw "$Executable and $Receipt must be directly managed files" }
    if (((Get-Item -LiteralPath $Executable).Attributes -band [IO.FileAttributes]::ReparsePoint) -or ((Get-Item -LiteralPath $Receipt).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$Executable and $Receipt must be directly managed files" }
    $CurrentDigest = (Get-FileHash -Algorithm SHA256 $Executable).Hash.ToLowerInvariant()
    if ($CurrentDigest -ne $env:YTM_CURRENT_SHA256) { throw "$Executable changed after upgrade validation" }
    if ([IO.File]::ReadAllText($Receipt) -cne (Receipt-Text $env:YTM_CURRENT_VERSION $CurrentDigest)) { throw "$Receipt changed after upgrade validation" }
    $CurrentReceiptDigest = (Get-FileHash -Algorithm SHA256 $Receipt).Hash.ToLowerInvariant()
    if ((Test-Path -LiteralPath $Previous) -or (Test-Path -LiteralPath $PreviousReceipt)) { throw "interrupted upgrade evidence exists at $Previous or $PreviousReceipt; preserve it and restore the verified pair before retrying" }
    try {
      $Marker = [IO.File]::Open($InProgress, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $InProgressOwned = $true
      $MarkerText = "version=$Version" + [Environment]::NewLine + "target=$Target" + [Environment]::NewLine
      $MarkerBytes = [Text.UTF8Encoding]::new($false).GetBytes($MarkerText)
      $Marker.Write($MarkerBytes, 0, $MarkerBytes.Length)
    } catch { throw "another or interrupted upgrade owns $InProgress" } finally { if ($Marker) { $Marker.Dispose() } }

    $Helper = Join-Path $InstallDir ('.ytm.upgrade.' + [Guid]::NewGuid().ToString('N') + '.ps1')
    $HelperLines = @(
      '$ErrorActionPreference = ''Stop''',
      '$Executable = ' + (Quote-Literal $Executable),
      '$Receipt = ' + (Quote-Literal $Receipt),
      '$Previous = ' + (Quote-Literal $Previous),
      '$PreviousReceipt = ' + (Quote-Literal $PreviousReceipt),
      '$Staged = ' + (Quote-Literal $Staged),
      '$StagedReceipt = ' + (Quote-Literal $StagedReceipt),
      '$Status = ' + (Quote-Literal $Status),
      '$InProgress = ' + (Quote-Literal $InProgress),
      '$Helper = ' + (Quote-Literal $Helper),
      '$Version = ' + (Quote-Literal $Version),
      '$Target = ' + (Quote-Literal $Target),
      '$ExpectedDigest = ' + (Quote-Literal $BinaryDigest),
      '$ExpectedReceiptDigest = ' + (Quote-Literal $ReceiptDigest),
      '$ExpectedCurrentDigest = ' + (Quote-Literal $CurrentDigest),
      '$ExpectedCurrentReceiptDigest = ' + (Quote-Literal $CurrentReceiptDigest),
      '$ParentPid = ' + [int]$env:YTM_PARENT_PID,
      '$ParentStartTicks = ' + (Quote-Literal $ParentStartTicks),
      '$HaveBackup = $false',
      '$TerminalStatusCommitted = $false',
      'function Write-Status([string]$Path, [string]$Json) {',
      '  $StatusTemp = $Path + ''.write.'' + [Guid]::NewGuid().ToString(''N'')',
      '  try {',
      '    [IO.File]::WriteAllText($StatusTemp, $Json, [Text.UTF8Encoding]::new($false))',
      '    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($StatusTemp, $Path, $null) }',
      '    else { [IO.File]::Move($StatusTemp, $Path) }',
      '  } finally {',
      '    if ([IO.File]::Exists($StatusTemp)) { [IO.File]::Delete($StatusTemp) }',
      '  }',
      '}',
      'try {',
      '  $WaitDeadline = [DateTime]::UtcNow.AddSeconds(120)',
      '  while ([DateTime]::UtcNow -lt $WaitDeadline) {',
      '    $Parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
      '    if (-not $Parent) { break }',
      '    try { $ObservedStartTicks = $Parent.StartTime.ToUniversalTime().Ticks.ToString() } catch { throw "could not confirm the parent process identity while waiting" }',
      '    if ($ObservedStartTicks -ne $ParentStartTicks) { break }',
      '    Start-Sleep -Milliseconds 200',
      '  }',
      '  $Parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
      '  if ($Parent) {',
      '    try { $ObservedStartTicks = $Parent.StartTime.ToUniversalTime().Ticks.ToString() } catch { throw "could not confirm the parent process identity after waiting" }',
      '    if ($ObservedStartTicks -eq $ParentStartTicks) { throw "the parent process did not exit before the replacement deadline" }',
      '  }',
      '  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or -not (Test-Path -LiteralPath $Receipt -PathType Leaf)) { throw "managed executable and receipt changed before replacement" }',
      '  if (((Get-Item -LiteralPath $Executable).Attributes -band [IO.FileAttributes]::ReparsePoint) -or ((Get-Item -LiteralPath $Receipt).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "managed executable and receipt must be directly managed files" }',
      '  if ((Get-FileHash -Algorithm SHA256 $Executable).Hash.ToLowerInvariant() -ne $ExpectedCurrentDigest) { throw "managed executable changed before replacement" }',
      '  if ((Get-FileHash -Algorithm SHA256 $Receipt).Hash.ToLowerInvariant() -ne $ExpectedCurrentReceiptDigest) { throw "managed receipt changed before replacement" }',
      '  if ((Test-Path -LiteralPath $Previous) -or (Test-Path -LiteralPath $PreviousReceipt)) { throw "recovery files already exist" }',
      '  [IO.File]::Move($Executable, $Previous)',
      '  try { [IO.File]::Move($Receipt, $PreviousReceipt) } catch { [IO.File]::Move($Previous, $Executable); throw }',
      '  $HaveBackup = $true',
      '  [IO.File]::Move($Staged, $Executable)',
      '  [IO.File]::Move($StagedReceipt, $Receipt)',
      '  if ((Get-FileHash -Algorithm SHA256 $Executable).Hash.ToLowerInvariant() -ne $ExpectedDigest) { throw "replacement digest verification failed" }',
      '  if ((Get-FileHash -Algorithm SHA256 $Receipt).Hash.ToLowerInvariant() -ne $ExpectedReceiptDigest) { throw "replacement receipt verification failed" }',
      '  $HaveBackup = $false',
      '  Remove-Item -LiteralPath $Previous, $PreviousReceipt -Force',
      '  $StatusJson = [ordered]@{ ok = $true; status = "upgraded"; version = $Version; target = $Target; installedSha256 = $ExpectedDigest; executable = $Executable; receipt = $Receipt } | ConvertTo-Json -Compress',
      '  Write-Status $Status $StatusJson',
      '  $TerminalStatusCommitted = $true',
      '} catch {',
      '  $Reason = $_.Exception.Message',
      '  $Restored = $false',
      '  if ($HaveBackup) {',
      '    try {',
      '      if (Test-Path -LiteralPath $Executable) { Remove-Item -LiteralPath $Executable -Force }',
      '      if (Test-Path -LiteralPath $Receipt) { Remove-Item -LiteralPath $Receipt -Force }',
      '      [IO.File]::Move($Previous, $Executable)',
      '      [IO.File]::Move($PreviousReceipt, $Receipt)',
      '      $Restored = $true',
      '    } catch { $Reason = $Reason + "; rollback failed: " + $_.Exception.Message }',
      '  }',
      '  $StatusJson = [ordered]@{ ok = $false; status = "recoverableFailure"; restored = $Restored; reason = $Reason; executable = $Executable; receipt = $Receipt; previous = $Previous; previousReceipt = $PreviousReceipt } | ConvertTo-Json -Compress',
      '  Write-Status $Status $StatusJson',
      '  $TerminalStatusCommitted = $true',
      '} finally {',
      '  if (Test-Path -LiteralPath $Staged) { Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue }',
      '  if (Test-Path -LiteralPath $StagedReceipt) { Remove-Item -LiteralPath $StagedReceipt -Force -ErrorAction SilentlyContinue }',
      '  if ($TerminalStatusCommitted -and (Test-Path -LiteralPath $InProgress)) { Remove-Item -LiteralPath $InProgress -Force -ErrorAction SilentlyContinue }',
      '  Remove-Item -LiteralPath $Helper -Force -ErrorAction SilentlyContinue',
      '}'
    )
    [IO.File]::WriteAllLines($Helper, $HelperLines, [Text.UTF8Encoding]::new($false))
    $ScheduledStatus = [ordered]@{ ok = $true; status = "scheduled"; version = $Version; target = $Target; executable = $Executable; receipt = $Receipt } | ConvertTo-Json -Compress
    $StatusOwned = $true
    Write-Status $Status $ScheduledStatus
    $HelperProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $Helper + '"')) -WindowStyle Hidden -PassThru
    $InProgressOwned = $false
    $StatusOwned = $false
    $Staged = $null
    $StagedReceipt = $null
    $Helper = $null
    Write-Output "scheduled ytm upgrade from v$($env:YTM_CURRENT_VERSION) to v$Version at $Executable; status will be written to $Status"
  } else {
    $FreshInstall = $true
    if ((Test-Path -LiteralPath $Previous) -or (Test-Path -LiteralPath $PreviousReceipt) -or (Test-Path -LiteralPath $InProgress)) { throw "interrupted upgrade evidence exists at $Previous, $PreviousReceipt, or $InProgress; preserve it and restore the verified pair before installing" }
    if ((Test-Path -LiteralPath $Executable) -or (Test-Path -LiteralPath $Receipt)) { throw "$Executable or $Receipt already exists; installation did not replace it" }
    $FreshStagedPath = $Staged
    $FreshExecutablePublished = $true
    [IO.File]::Move($Staged, $Executable)
    $Staged = $null
    try {
      [IO.File]::Move($StagedReceipt, $Receipt)
      $StagedReceipt = $null
      $FreshCommitted = $true
    } catch {
      try { Remove-Item -LiteralPath $Executable -Force } catch { throw "receipt publication failed and $Executable could not be removed; preserve it as an uncommitted install: $($_.Exception.Message)" }
      throw "$Receipt could not be published; installation removed the uncommitted executable"
    }
    Write-Output "installed ytm v$Version to $Executable"
  }
} finally {
  if ($FreshInstall -and $FreshExecutablePublished -and -not $FreshCommitted -and $FreshStagedPath -and -not (Test-Path -LiteralPath $FreshStagedPath) -and (Test-Path -LiteralPath $Executable) -and -not (Test-Path -LiteralPath $Receipt)) {
    if ((Get-FileHash -Algorithm SHA256 $Executable).Hash.ToLowerInvariant() -eq $BinaryDigest) {
      try {
        Remove-Item -LiteralPath $Executable -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $Executable) { throw 'the executable still exists after removal' }
      } catch { throw "fresh installation was interrupted; preserve the uncommitted executable at \${Executable}: $($_.Exception.Message)" }
    }
  }
  if ($Staged -and (Test-Path -LiteralPath $Staged)) { Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue }
  if ($StagedReceipt -and (Test-Path -LiteralPath $StagedReceipt)) { Remove-Item -LiteralPath $StagedReceipt -Force -ErrorAction SilentlyContinue }
  if ($Helper -and (Test-Path -LiteralPath $Helper)) { Remove-Item -LiteralPath $Helper -Force -ErrorAction SilentlyContinue }
  if ($InProgressOwned -and -not $HelperProcess) {
    if ($StatusOwned -and (Test-Path -LiteralPath $Status)) {
      try {
        Remove-Item -LiteralPath $Status -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $Status) { throw 'the scheduled status still exists after removal' }
      } catch { throw "upgrade helper did not start; preserve the ownership marker at \${InProgress} because scheduled-status cleanup failed at \${Status}: $($_.Exception.Message)" }
    }
  }
  if ($InProgressOwned -and -not $HelperProcess -and (Test-Path -LiteralPath $InProgress)) {
    try {
      Remove-Item -LiteralPath $InProgress -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $InProgress) { throw 'the ownership marker still exists after removal' }
    } catch { throw "upgrade helper did not start; preserve and inspect the ownership marker at \${InProgress}: $($_.Exception.Message)" }
  }
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

function requiredDigest(digests, archive) {
  const digest = digests.get(archive);
  if (!/^[0-9a-f]{64}$/.test(digest || "")) throw new Error(`Missing SHA-256 digest for ${archive}.`);
  return digest;
}
