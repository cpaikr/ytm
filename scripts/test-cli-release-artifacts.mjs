import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { cliArchiveName, loadCliReleasePolicy, validateCliManifest } from "./cli-release-policy.mjs";
import { parseChecksumFile } from "./cli-artifact-validation.mjs";
import { createTarGz, readTarGz } from "./deterministic-archive.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const sourceCommit = run("git", ["rev-parse", "HEAD"], repositoryRoot).stdout.trim();
const temporaryRoot = await mkdtemp(join(tmpdir(), "ytm-cli-release-test-"));
const pathExists = (path) => access(path).then(() => true, () => false);

try {
  const canonicalGzip = createTarGz([{ name: "fixture", mode: 0o644, contents: Buffer.from("fixture") }]);
  assertEqual(canonicalGzip[9], 0xff, "tar.gz archives must use the platform-independent gzip OS marker");
  const orderedNames = readTarGz(createTarGz([
    { name: "z", mode: 0o644, contents: Buffer.alloc(0) },
    { name: "ä", mode: 0o644, contents: Buffer.alloc(0) },
    { name: "a", mode: 0o644, contents: Buffer.alloc(0) }
  ])).map(({ name }) => name);
  assertEqual(orderedNames, ["a", "z", "ä"], "archive entry ordering must use locale-independent code units");
  const matrix = JSON.parse(runNode("scripts/print-cli-matrix.mjs", []).stdout).include;
  assertEqual(
    matrix.map(({ usesGlibcFloor }) => usesGlibcFloor),
    manifest.targets.map((target) => target.os === "linux" && target.libc === "glibc"),
    "CI matrix must expose the target build policy"
  );
  const first = join(temporaryRoot, "first");
  const second = join(temporaryRoot, "second");
  await assembleCandidate(first);
  await assembleCandidate(second);
  const shellInstaller = await readFile(join(first, manifest.installerAssets.shell), "utf8");
  const powershellInstaller = await readFile(join(first, manifest.installerAssets.powershell), "utf8");
  if (!shellInstaller.includes('staged="$(mktemp "$install_dir/.ytm.install.XXXXXXXX")"')) {
    throw new Error("Shell installer must create its staging file atomically inside the install directory.");
  }
  if (powershellInstaller.indexOf("IsOSPlatform") === -1 || powershellInstaller.indexOf("IsOSPlatform") > powershellInstaller.indexOf("$InstallDir =")) {
    throw new Error("PowerShell installer must reject non-Windows hosts before deriving the install path.");
  }
  if (!shellInstaller.includes("sha256sum") || !shellInstaller.includes("shasum -a 256") || !shellInstaller.includes('[ "$actual" = "$expected" ]')) {
    throw new Error("Shell installer must verify its pinned archive digest.");
  }
  if (!powershellInstaller.includes("Get-FileHash -Algorithm SHA256") || !powershellInstaller.includes("$Actual -ne $Expected")) {
    throw new Error("PowerShell installer must verify its pinned archive digest.");
  }
  for (const marker of ["schema=1", "release_source=https://github.com/", "installed_sha256=", "YTM_MANAGED_UPGRADE", ".ytm.previous", "automatic rollback was incomplete", "same_file", "--max-time 120", "--timeout=30"]) {
    if (!shellInstaller.includes(marker)) throw new Error(`Shell installer is missing managed-install marker ${marker}.`);
  }
  if (shellInstaller.includes(' -ef ')) throw new Error("Shell installer must not depend on the non-POSIX test -ef operator.");
  for (const marker of ["schema=1", "YTM_MANAGED_UPGRADE", ".ytm.exe.previous", "ParentStartTicks", "AddSeconds(120)", "recoverableFailure", "upgrade-status.json", "upgrade-in-progress", "FileMode]::CreateNew", "Start-Process", "-PassThru", "-TimeoutSec 120", "status = \"scheduled\"", "[IO.File]::Replace", "$TerminalStatusCommitted", "$StatusOwned = $true", "preserve the uncommitted executable at ${Executable}"]) {
    if (!powershellInstaller.includes(marker)) throw new Error(`PowerShell installer is missing managed-install marker ${marker}.`);
  }
  if (powershellInstaller.includes("Set-Content -LiteralPath $Status")) throw new Error("PowerShell status JSON must use no-BOM atomic writes.");
  const publishedChecksums = parseChecksumFile(await readFile(join(first, manifest.checksumFile), "utf8"));
  for (const target of manifest.targets) {
    const archive = cliArchiveName(manifest, target, version);
    const digest = publishedChecksums.get(archive);
    const installer = target.shellKernel ? shellInstaller : powershellInstaller;
    if (!digest || !installer.includes(digest)) throw new Error(`Installer for ${target.key} must pin ${archive}.`);
  }
  if (process.platform !== "win32") {
    run("sh", ["-n", join(first, manifest.installerAssets.shell)], repositoryRoot);
    await testShellManagedInstall(first, shellInstaller, publishedChecksums);
  }
  const firstFiles = (await readdir(first)).sort();
  const secondFiles = (await readdir(second)).sort();
  assertEqual(firstFiles, secondFiles, "deterministic candidates must have identical file names");
  for (const file of firstFiles) {
    const left = await readFile(join(first, file));
    const right = await readFile(join(second, file));
    if (!left.equals(right)) throw new Error(`${file} was not generated deterministically.`);
  }

  const duplicate = structuredClone(manifest);
  duplicate.targets[1].key = duplicate.targets[0].key;
  assertThrows(() => validateCliManifest(duplicate, linuxBuild), "unique key");
  const fallback = structuredClone(manifest);
  fallback.targets[0].archiveFormat = "zip";
  assertThrows(() => validateCliManifest(fallback, linuxBuild), "must use tar.gz");

  const checksumPath = join(first, manifest.checksumFile);
  const validChecksums = await readFile(checksumPath, "utf8");
  await writeFile(checksumPath, validChecksums.replace(/^[0-9a-f]/, (value) => value === "f" ? "e" : "f"));
  assertFailed(runNode("scripts/validate-cli-artifact-set.mjs", [first], false), "Checksum mismatch");
  await copyCandidate(second, first);

  await mkdir(join(first, "unexpected"));
  assertFailed(runNode("scripts/validate-cli-artifact-set.mjs", [first], false), "non-file entries");
  await copyCandidate(second, first);

  const target = manifest.targets.find((candidate) => candidate.archiveFormat === "tar.gz");
  const archiveName = cliArchiveName(manifest, target, version);
  const archivePath = join(first, archiveName);
  const entries = readTarGz(await readFile(archivePath));
  entries.push({ name: `${archiveName.slice(0, -7)}/private.env`, mode: 0o600, contents: Buffer.from("secret") });
  const tampered = createTarGz(entries);
  await writeFile(archivePath, tampered);
  const digest = createHash("sha256").update(tampered).digest("hex");
  const checksums = (await readFile(checksumPath, "utf8")).replace(new RegExp(`^[0-9a-f]{64}  ${escapeRegExp(archiveName)}$`, "m"), `${digest}  ${archiveName}`);
  await writeFile(checksumPath, checksums);
  assertFailed(runNode("scripts/validate-cli-artifact-set.mjs", [first], false), "entries must be exactly");
  await copyCandidate(second, first);

  const trailingPath = join(first, archiveName);
  const trailingArchive = Buffer.concat([await readFile(trailingPath), gzipSync(Buffer.from("trailing-private-material"), { mtime: 0 })]);
  await writeFile(trailingPath, trailingArchive);
  const trailingDigest = createHash("sha256").update(trailingArchive).digest("hex");
  const trailingChecksums = (await readFile(checksumPath, "utf8")).replace(new RegExp(`^[0-9a-f]{64}  ${escapeRegExp(archiveName)}$`, "m"), `${trailingDigest}  ${archiveName}`);
  await writeFile(checksumPath, trailingChecksums);
  assertFailed(runNode("scripts/validate-cli-artifact-set.mjs", [first], false), "canonical deterministic archive");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("CLI release generators are deterministic and reject manifest, checksum, and archive-content failures");

async function assembleCandidate(directory) {
  for (const target of manifest.targets) {
    const binary = join(temporaryRoot, `${target.key}.bin`);
    await writeFile(binary, fakeExecutable(target));
    runNode("scripts/assemble-cli-archive.mjs", [target.rustTarget, directory, "--source-commit", sourceCommit, "--binary", binary]);
  }
  runNode("scripts/generate-cli-installers.mjs", [directory]);
  runNode("scripts/finalize-cli-artifacts.mjs", [directory]);
  runNode("scripts/validate-cli-artifact-set.mjs", [directory]);
}

async function copyCandidate(source, destination) {
  await rm(destination, { recursive: true, force: true });
  const { copyFile } = await import("node:fs/promises");
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(source)) await copyFile(join(source, file), join(destination, file));
}

async function testShellManagedInstall(candidate, installer, checksums) {
  const hostKernel = { darwin: "Darwin", linux: "Linux" }[process.platform];
  const hostMachine = { arm64: "arm64", x64: "x86_64" }[process.arch];
  if (!hostKernel || !hostMachine) return;
  const hostTarget = manifest.targets.find((target) =>
    target.shellKernel === hostKernel && target.shellMachines.includes(hostMachine)
  );
  if (!hostTarget) return;
  const installDir = join(temporaryRoot, "managed-install");
  const installerPath = join(candidate, manifest.installerAssets.shell);
  const environment = {
    ...process.env,
    YTM_INSTALL_DIR: installDir,
    YTM_RELEASE_BASE_URL: pathToFileURL(candidate).href.replace(/\/$/, "")
  };
  run("sh", [installerPath], repositoryRoot, true, environment);
  const executable = join(installDir, "ytm");
  const receipt = join(installDir, "ytm.receipt");
  const executableDigest = createHash("sha256").update(await readFile(executable)).digest("hex");
  assertEqual(
    await readFile(receipt, "utf8"),
    `schema=1\nversion=${version}\ntarget=${hostTarget.key}\nexecutable=ytm\nrelease_source=https://github.com/${manifest.repository}/releases/download/v${version}\ninstalled_sha256=${executableDigest}\n`,
    "fresh install must publish the exact adjacent receipt"
  );
  const originalExecutable = await readFile(executable);
  const originalReceipt = await readFile(receipt);
  assertFailed(run("sh", [installerPath], repositoryRoot, false, environment), "already exists");
  if (!(await readFile(executable)).equals(originalExecutable) || !(await readFile(receipt)).equals(originalReceipt)) {
    throw new Error("refused fresh install must preserve the installed executable and receipt");
  }

  for (const evidenceName of [".ytm.previous", ".ytm.receipt.previous"]) {
    const evidenceInstallDir = join(temporaryRoot, `fresh-recovery-evidence-${evidenceName.slice(1)}`);
    const evidence = Buffer.from("preserve recovery evidence");
    const evidencePath = join(evidenceInstallDir, evidenceName);
    await mkdir(evidenceInstallDir, { recursive: true });
    await writeFile(evidencePath, evidence);
    const evidenceEnvironment = { ...environment, YTM_INSTALL_DIR: evidenceInstallDir };
    assertFailed(run("sh", [installerPath], repositoryRoot, false, evidenceEnvironment), "interrupted upgrade evidence");
    if (!(await readFile(evidencePath)).equals(evidence)) throw new Error(`fresh install changed recovery evidence at ${evidencePath}`);
    for (const path of [join(evidenceInstallDir, "ytm"), join(evidenceInstallDir, "ytm.receipt")]) {
      if (await pathExists(path)) throw new Error(`fresh install with recovery evidence left ${path}`);
    }
  }

  const interruptedInstallDir = join(temporaryRoot, "interrupted-fresh-install");
  const interruptedInstaller = join(temporaryRoot, "install-interrupted.sh");
  const interrupted = installer.replace(
    '  ln "$staged" "$executable" || { printf \'%s\\n\' "$executable already exists; installation did not replace it" >&2; exit 1; }',
    '  ln "$staged" "$executable" || { printf \'%s\\n\' "$executable already exists; installation did not replace it" >&2; exit 1; }\n  kill -TERM $$ # injected interruption before receipt publication'
  );
  if (interrupted === installer) throw new Error("could not inject fresh-install interruption");
  await writeFile(interruptedInstaller, interrupted, { mode: 0o755 });
  const interruptedEnvironment = { ...environment, YTM_INSTALL_DIR: interruptedInstallDir };
  assertFailed(run("sh", [interruptedInstaller], repositoryRoot, false, interruptedEnvironment), "");
  for (const path of [join(interruptedInstallDir, "ytm"), join(interruptedInstallDir, "ytm.receipt")]) {
    if (await pathExists(path)) throw new Error(`interrupted fresh install left ${path}`);
  }

  const tamperedInstallDir = join(temporaryRoot, "tampered-copy-install");
  const tamperedInstaller = join(temporaryRoot, "install-tampered-copy.sh");
  const tamperedCopy = installer.replace(
    'chmod 755 "$staged"',
    'chmod 755 "$staged"\nprintf \'staged-copy-change\' >> "$staged" # injected successful copy alteration'
  );
  if (tamperedCopy === installer) throw new Error("could not inject staged-copy alteration");
  await writeFile(tamperedInstaller, tamperedCopy, { mode: 0o755 });
  const tamperedEnvironment = { ...environment, YTM_INSTALL_DIR: tamperedInstallDir };
  run("sh", [tamperedInstaller], repositoryRoot, true, tamperedEnvironment);
  const tamperedExecutable = join(tamperedInstallDir, "ytm");
  const tamperedReceipt = await readFile(join(tamperedInstallDir, "ytm.receipt"), "utf8");
  const tamperedDigest = createHash("sha256").update(await readFile(tamperedExecutable)).digest("hex");
  if (!tamperedReceipt.endsWith(`installed_sha256=${tamperedDigest}\n`)) {
    throw new Error("fresh-install receipt must hash the staged executable bytes");
  }

  const archive = cliArchiveName(manifest, hostTarget, version);
  const managedEnvironment = {
    ...environment,
    YTM_MANAGED_UPGRADE: "1",
    YTM_CURRENT_VERSION: version,
    YTM_CURRENT_SHA256: executableDigest,
    YTM_EXPECTED_VERSION: version,
    YTM_EXPECTED_ARCHIVE_SHA256: checksums.get(archive)
  };
  run("sh", [installerPath], repositoryRoot, true, managedEnvironment);
  if (!(await readFile(executable)).equals(originalExecutable) || !(await readFile(receipt)).equals(originalReceipt)) {
    throw new Error("managed replacement must publish the verified executable and receipt pair");
  }
  for (const recoveryFile of [join(installDir, ".ytm.previous"), join(installDir, ".ytm.receipt.previous")]) {
    if (await pathExists(recoveryFile)) throw new Error(`successful managed replacement left ${recoveryFile}`);
  }

  const failingInstaller = join(temporaryRoot, "install-failing.sh");
  const injected = installer.replace(
    '  mv -f "$staged_receipt" "$receipt"',
    '  false # injected receipt-publication failure\n  mv -f "$staged_receipt" "$receipt"'
  );
  if (injected === installer) throw new Error("could not inject shell transaction failure");
  await writeFile(failingInstaller, injected, { mode: 0o755 });
  assertFailed(run("sh", [failingInstaller], repositoryRoot, false, managedEnvironment), "");
  if (!(await readFile(executable)).equals(originalExecutable) || !(await readFile(receipt)).equals(originalReceipt)) {
    throw new Error("managed replacement failure must restore the prior executable and receipt");
  }
  for (const recoveryFile of [join(installDir, ".ytm.previous"), join(installDir, ".ytm.receipt.previous")]) {
    if (await pathExists(recoveryFile)) throw new Error(`completed rollback left ${recoveryFile}`);
  }
}

function fakeExecutable(target) {
  const binary = Buffer.alloc(128);
  if (target.os === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(binary);
    binary[4] = 2;
    binary[5] = 1;
    binary.writeUInt16LE(target.arch === "x64" ? 62 : 183, 18);
  } else if (target.os === "darwin") {
    binary.writeUInt32LE(0xfeedfacf, 0);
    binary.writeUInt32LE(0x0100000c, 4);
  } else {
    binary.write("MZ", 0, "ascii");
    binary.writeUInt32LE(0x40, 0x3c);
    binary.write("PE\0\0", 0x40, "latin1");
    binary.writeUInt16LE(0x8664, 0x44);
  }
  return binary;
}

function runNode(script, args, requireSuccess = true) {
  return run(process.execPath, [resolve(repositoryRoot, script), ...args], repositoryRoot, requireSuccess);
}

function run(command, args, cwd, requireSuccess = true, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (requireSuccess && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function assertFailed(result, diagnostic) {
  if (result.status === 0) throw new Error(`Expected failure containing ${diagnostic}.`);
  if (!`${result.stdout}\n${result.stderr}`.includes(diagnostic)) {
    throw new Error(`Failure did not contain ${diagnostic}:\n${result.stdout}\n${result.stderr}`);
  }
}

function assertThrows(callback, diagnostic) {
  try {
    callback();
  } catch (error) {
    if (String(error.message).includes(diagnostic)) return;
    throw error;
  }
  throw new Error(`Expected error containing ${diagnostic}.`);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
