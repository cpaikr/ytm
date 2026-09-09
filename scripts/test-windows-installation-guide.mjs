import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Execute the documented PATH transformations with only registry I/O replaced.
// Never change the developer's persistent PATH. This is not a Windows consumer test.
export async function testWindowsInstallationGuide(installer) {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const available = spawnSync(shell, ["-NoProfile", "-Command", "exit 0"], { timeout: 30_000 });
  if (available.error?.code === "ENOENT") {
    console.log("SKIP Windows guide execution: PowerShell unavailable; independent Windows consumer validation still required.");
    return;
  }
  if (available.error || available.status !== 0) throw new Error(`PowerShell unavailable: ${available.error || available.stderr}`);
  const guide = await readFile(new URL("../docs/windows-installation.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const blocks = [...guide.matchAll(/```powershell\n([\s\S]*?)```/g)].map((match) => match[1]);
  const registration = blocks.find((block) => block.includes("function Test-YtmPathEntry"));
  const sessionBlock = blocks.find((block) => block.startsWith("if (-not (Test-YtmPathEntry $env:Path"));
  const current = sessionBlock?.split("$ytmCommand =")[0];
  const commandGuard = sessionBlock?.match(/(\$ytmCommand = [\s\S]*?)\nytm --version/)?.[1];
  if (!registration || !current || !commandGuard) throw new Error("Windows PATH examples are missing.");
  const isolated = registration
    .replace("[Environment]::GetEnvironmentVariable('Path', 'User')", "$storedPath")
    .replace("[Environment]::SetEnvironmentVariable('Path', $ytmNewUserPath, 'User')", "$storedPath = $ytmNewUserPath; $writes++");
  const directory = await mkdtemp(join(tmpdir(), "ytm-path-guide-"));
  try {
    const snippets = [...blocks, ...[...readme.matchAll(/```powershell\n([\s\S]*?)```/g)].map((match) => match[1]), installer];
    await writeFile(join(directory, "snippets.json"), JSON.stringify(snippets));
    await writeFile(join(directory, "test.ps1"), `
$ErrorActionPreference = 'Stop'
$originalProcessPath = $env:Path
foreach ($source in (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'snippets.json') | ConvertFrom-Json)) {
  $tokens = $null; $parseErrors = $null
  [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$ytmBin = 'C:\\Custom Tools\\ytm'
$env:YTM_GUIDE_TEST_ROOT = 'C:\\Custom Tools'
foreach ($case in @(
  @{ before = $null; after = $ytmBin; writes = 1 },
  @{ before = ''; after = $ytmBin; writes = 1 },
  @{ before = 'C:\\Existing'; after = 'C:\\Existing;' + $ytmBin; writes = 1 },
  @{ before = 'C:\\Existing;'; after = 'C:\\Existing;' + $ytmBin; writes = 1 },
  @{ before = 'C:\\Existing;;C:\\Other'; after = 'C:\\Existing;;C:\\Other;' + $ytmBin; writes = 1 },
  @{ before = 'C:\\CUSTOM TOOLS\\YTM\\;C:\\Other'; after = 'C:\\CUSTOM TOOLS\\YTM\\;C:\\Other'; writes = 0 },
  @{ before = '"%YTM_GUIDE_TEST_ROOT%\\ytm";C:\\Other'; after = '"%YTM_GUIDE_TEST_ROOT%\\ytm";C:\\Other'; writes = 0 },
  @{ before = 'C:\\Custom Tools\\ytm-old'; after = 'C:\\Custom Tools\\ytm-old;' + $ytmBin; writes = 1 }
)) {
  $storedPath = $case.before; $writes = 0
  $env:Path = 'C:\\SessionOnly'
  . { ${isolated} }
  . { ${isolated} }
  if ($storedPath -cne $case.after -or $writes -ne $case.writes) { throw "Registration changed entries or duplicated destination: $storedPath" }
  if ($env:Path -cne 'C:\\SessionOnly') { throw 'Registration changed current PATH' }
  . { ${current} }
  . { ${current} }
  if ($env:Path -cne ($ytmBin + ';C:\\SessionOnly')) { throw 'Current-session setup lost entries or duplicated destination' }
  if ($storedPath -cne $case.after) { throw 'Session setup changed persistent PATH' }
}
$env:Path = $originalProcessPath
$shellExecutable = (Get-Process -Id $PID).Path
function Assert-CommandGuard([string]$probeName, [string]$expected, [bool]$shouldPass) {
  $ytmExe = $expected
  $passed = $false
  try {
    . { ${commandGuard.replace('Get-Command ytm', 'Get-Command $probeName')} }
    $passed = $true
  } catch {
    if ($_.Exception.Message -notlike 'ytm resolves to a different command:*') { throw }
  }
  if ($passed -ne $shouldPass) { throw "Unexpected command guard result for $probeName" }
}
Assert-CommandGuard $shellExecutable $shellExecutable $true
Assert-CommandGuard $shellExecutable ($shellExecutable + '.other') $false
Set-Alias -Name ytm -Value Get-Item
Assert-CommandGuard 'ytm' $shellExecutable $false
Remove-Item Alias:ytm
function ytm { throw 'Shadowing function must not run' }
Assert-CommandGuard 'ytm' $shellExecutable $false
Remove-Item Function:ytm
Write-Output 'Windows guide syntax, isolated PATH behavior, and command-shadowing guards passed; registry persistence and independent Windows visibility are not certified.'
`);
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-File", join(directory, "test.ps1")], { encoding: "utf8", timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`Windows guide test failed: ${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    console.log(result.stdout.trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
