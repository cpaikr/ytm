# Windows installation and recovery

Use the [official release installer](../README.md#windows) in an ordinary
PowerShell terminal. These recovery steps also work with the v0.4.0 installer,
which predates the additional installer visibility message in this checkout.

## Visibility recovery

If the installer sees `ytm.exe` but an independently opened terminal cannot see
the advertised full path, fix file visibility first. Correct PATH cannot make a
missing file executable. Shells launched by the same packaged application can
inherit its filesystem view, even with different environment variables.

[Issue #42](https://github.com/cpaikr/ytm/issues/42) records Windows AppData
redirection under the MSIX-packaged Codex app. An open-handle query resolved the
advertised `%LOCALAPPDATA%\ytm\bin\ytm.exe` into the app's private
`%LOCALAPPDATA%\Packages\OpenAI.Codex_<family>\LocalCache\Local\ytm\bin`.
This is evidence for that incident, not a diagnosis of every missing executable.

Run the README installer from a normal PowerShell terminal opened independently
of the agent. Alternatively, choose a destination visible to that terminal:

```powershell
$env:YTM_INSTALL_DIR = Join-Path $env:USERPROFILE '.local\bin'
```

Then run the README installation block. This was the incident's verified physical
recovery location, not a required global default. Other custom destinations
remain supported. Reinstalling creates both `ytm.exe` and `ytm.exe.receipt`;
preserve the adjacent receipt for managed upgrades. Fresh installation refuses
to overwrite either existing file: use a new destination, or the documented
[managed upgrade path](../README.md#upgrade) for an existing valid pair. Do not
delete receipt or interrupted-upgrade evidence to force a reinstall.

The incident independently confirmed Darty's help command after recovery.
YTM's files were verified in the installing context, but independent YTM command
execution was not separately confirmed. Run the checks below for YTM itself.

## PATH setup

In the independent terminal, select the directory actually used above. If this
is a different terminal, set `YTM_INSTALL_DIR` to the same absolute custom path
used for installation; otherwise the block selects the default. Do not reuse a
relative path across terminals with different working directories.

```powershell
$ytmBin = if ($env:YTM_INSTALL_DIR) { $env:YTM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ytm\bin' }
$ytmBin = [IO.Path]::GetFullPath($ytmBin)
$ytmExe = Join-Path $ytmBin 'ytm.exe'
if (-not (Test-Path -LiteralPath $ytmExe -PathType Leaf)) { throw "Not visible: $ytmExe. Follow visibility recovery before editing PATH." }
if (-not (Test-Path -LiteralPath "$ytmExe.receipt" -PathType Leaf)) { throw 'Managed installation receipt is missing' }
& $ytmExe --version
if ($LASTEXITCODE -ne 0) { throw 'Full-path version check failed' }
& $ytmExe --help
if ($LASTEXITCODE -ne 0) { throw 'Full-path help check failed' }
```

Register the selected directory in persistent **user** PATH. This preserves the
stored entries without copying the merged process PATH into user PATH. Comparison
ignores case, surrounding quotes, trailing separators, and expands `%VARIABLE%`
entries, so repeating registration does not add another equivalent entry.

```powershell
function Test-YtmPathEntry([string]$pathValue, [string]$directory) {
  $wanted = $directory.TrimEnd('\', '/')
  foreach ($entry in ($pathValue -split ';')) {
    $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"')).TrimEnd('\', '/')
    if ([string]::Equals($expanded, $wanted, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
$ytmUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (Test-YtmPathEntry $ytmUserPath $ytmBin)) {
  $ytmNewUserPath = if ([string]::IsNullOrEmpty($ytmUserPath)) { $ytmBin } elseif ($ytmUserPath.EndsWith(';')) { $ytmUserPath + $ytmBin } else { $ytmUserPath + ';' + $ytmBin }
  [Environment]::SetEnvironmentVariable('Path', $ytmNewUserPath, 'User')
}
```

Separately update **this session**, which retains its inherited PATH even after
the persistent value changes. Run after the preceding blocks:

```powershell
if (-not (Test-YtmPathEntry $env:Path $ytmBin)) {
  $env:Path = $ytmBin + ';' + $env:Path
}
$ytmCommand = Get-Command ytm -ErrorAction Stop
if ($ytmCommand.CommandType -ne 'Application' -or $ytmCommand.Source -ne $ytmExe) {
  throw "ytm resolves to a different command: $($ytmCommand.Definition). Resolve the alias, function, or PATH conflict first."
}
ytm --version
if ($LASTEXITCODE -ne 0) { throw 'Command-name version check failed' }
ytm --help
if ($LASTEXITCODE -ne 0) { throw 'Command-name help check failed' }
```

The block rejects aliases, functions, and other executable paths before running
`ytm`. Check that the reported version matches the installed release.

## Consumer verification

Keep the successful current-terminal checks. Then open a new ordinary terminal
outside the installing app and repeat the full-path checks and the command-name
checks above, **without** applying the current-session PATH step. Use the same
selected directory. A new tab can inherit stale PATH from an existing terminal
host; fully reopen that host, or sign out and back in if necessary, to obtain an
updated environment. Compare the stored user PATH with `$env:Path` to distinguish
registration from inheritance.

Record the release, selected directory, terminal launch context, receipt presence,
full-path results, `Get-Command` result, and command-name version/help results in
both terminals. A subprocess of the packaged installer does not cross the
required boundary. Automation is valid when its launch mechanism actually
crosses that boundary; otherwise record the remaining independent-consumer gap.
