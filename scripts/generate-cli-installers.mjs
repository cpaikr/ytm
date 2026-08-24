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
      return `  ${target.shellKernel}:${machine}) archive='${archive}'; root='${root}'; expected='${requiredDigest(digests, archive)}' ;;`;
    })
  ).join("\n");
  return `#!/bin/sh
set -eu

version='${version}'
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
cleanup() { rm -rf "$tmp"; if [ -n "$staged" ]; then rm -f "$staged"; fi; }
trap cleanup EXIT HUP INT TERM
download() {
  if command -v curl >/dev/null 2>&1; then curl --fail --location --silent --show-error "$1" --output "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else printf '%s\\n' 'ytm installer requires curl or wget' >&2; exit 1
  fi
}
download "$release_base/$archive" "$tmp/$archive"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
else printf '%s\\n' 'ytm installer requires sha256sum or shasum' >&2; exit 1
fi
[ "$actual" = "$expected" ] || { printf '%s\\n' "checksum mismatch for $archive" >&2; exit 1; }
tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/$root/ytm" ] || { printf '%s\\n' 'archive does not contain ytm' >&2; exit 1; }
mkdir -p "$install_dir"
[ ! -e "$install_dir/ytm" ] || { printf '%s\\n' "$install_dir/ytm already exists; managed replacement is not available yet" >&2; exit 1; }
staged="$(mktemp "$install_dir/.ytm.install.XXXXXXXX")"
cp "$tmp/$root/ytm" "$staged"
chmod 755 "$staged"
ln "$staged" "$install_dir/ytm" || { printf '%s\\n' "$install_dir/ytm already exists; installation did not replace it" >&2; exit 1; }
rm -f "$staged"
staged=''
printf '%s\\n' "installed ytm v$version to $install_dir/ytm"
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
$ReleaseBase = if ($env:YTM_RELEASE_BASE_URL) { $env:YTM_RELEASE_BASE_URL } else { '${releaseBaseUrl(manifest, version)}' }
if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) { throw "ytm v$Version supports Windows x64 only" }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw "ytm v$Version supports Windows x64 only" }
$InstallDir = if ($env:YTM_INSTALL_DIR) { $env:YTM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ytm\\bin' }
$Archive = '${archive}'
$Expected = '${expected}'
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('ytm-install-' + [Guid]::NewGuid().ToString('N'))
$Staged = $null
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$Archive" -OutFile (Join-Path $Temp $Archive)
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temp $Archive)).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "checksum mismatch for $Archive" }
  Expand-Archive -LiteralPath (Join-Path $Temp $Archive) -DestinationPath $Temp
  $Root = '${root}'
  $Binary = Join-Path (Join-Path $Temp $Root) 'ytm.exe'
  if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw 'archive does not contain ytm.exe' }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if (Test-Path -LiteralPath (Join-Path $InstallDir 'ytm.exe')) { throw "$InstallDir\\ytm.exe already exists; managed replacement is not available yet" }
  $Staged = Join-Path $InstallDir ('.ytm.install.' + [Guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath $Binary -Destination $Staged
  [IO.File]::Move($Staged, (Join-Path $InstallDir 'ytm.exe'))
  $Staged = $null
  Write-Output "installed ytm v$Version to $(Join-Path $InstallDir 'ytm.exe')"
} finally {
  if ($Staged -and (Test-Path -LiteralPath $Staged)) { Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

function requiredDigest(digests, archive) {
  const digest = digests.get(archive);
  if (!/^[0-9a-f]{64}$/.test(digest || "")) throw new Error(`Missing SHA-256 digest for ${archive}.`);
  return digest;
}
