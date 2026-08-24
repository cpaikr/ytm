import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArchiveName, cliArchiveRoot, loadCliReleasePolicy } from "./cli-release-policy.mjs";
import { parseChecksumFile } from "./cli-artifact-validation.mjs";
import { readTarGz, readZip } from "./deterministic-archive.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const candidate = resolve(process.argv[2] || "");
const rustTarget = process.argv[3] || process.env.RUST_TARGET;
if (!process.argv[2] || !rustTarget) {
  throw new Error("Usage: node scripts/test-cli-release-consumer.mjs <candidate-directory> <rust-target>");
}

const { manifest } = await loadCliReleasePolicy(repositoryRoot);
const target = manifest.targets.find((entry) => entry.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown CLI target ${rustTarget}.`);
if (target.os !== process.platform || target.arch !== process.arch) {
  throw new Error(`CLI target ${target.key} requires ${target.os}/${target.arch}; consumer is ${process.platform}/${process.arch}.`);
}

const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const archiveName = cliArchiveName(manifest, target, version);
const archive = await readFile(join(candidate, archiveName));
const checksums = parseChecksumFile(await readFile(join(candidate, manifest.checksumFile), "utf8"));
const archiveDigest = sha256(archive);
if (checksums.get(archiveName) !== archiveDigest) throw new Error(`Candidate checksum for ${archiveName} is not truthful.`);

const entries = target.archiveFormat === "zip" ? readZip(archive) : readTarGz(archive);
const archivedExecutable = entries.find(({ name }) => name === `${cliArchiveRoot(manifest, target, version)}/${target.executableFile}`)?.contents;
if (!archivedExecutable) throw new Error(`${archiveName} does not contain ${target.executableFile}.`);

const temporaryRoot = await mkdtemp(join(tmpdir(), `ytm-cli-consumer-${target.key}-`));
const server = createServer(async (request, response) => {
  try {
    const [mode, requested] = new URL(request.url, "http://127.0.0.1").pathname.slice(1).split("/");
    if (mode === "missing") {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("injected download failure");
      return;
    }
    const file = await readFile(join(candidate, basename(requested || "")));
    const body = mode === "corrupt" && requested === archiveName ? Buffer.concat([file, Buffer.from("corrupt")]) : file;
    response.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not start the candidate fixture server.");
const releaseBase = `http://127.0.0.1:${address.port}`;

try {
  await runNode("scripts/validate-cli-artifact-set.mjs", [candidate]);
  await testFreshInstall("ok");
  await testFreshFailure("missing", "503");
  await testFreshFailure("corrupt", "checksum mismatch");
  await testManagedUpgrade("success");
  await testManagedUpgrade("replacement");
  await testManagedUpgrade("receipt");
  await testManagedUpgrade("interruption");
  await testManagedUpgrade("restoration");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`exact CLI candidate passed native install, integrity, upgrade, and recovery tests for ${target.key}`);

async function testFreshInstall(mode) {
  const installDir = join(temporaryRoot, "fresh");
  const result = await runInstaller(installerPath(), installEnvironment(installDir, mode));
  assertSucceeded(result, "exact fresh install");
  await assertInstalledPair(installDir);
  const executable = executablePath(installDir);
  assertSucceeded(await runProcess(executable, ["--version"]), "installed --version", `ytm ${version}`);
  assertSucceeded(await runProcess(executable, ["--help"]), "installed --help", "CLI usage:");
}

async function testFreshFailure(mode, diagnostic) {
  const installDir = join(temporaryRoot, `fresh-${mode}`);
  const result = await runInstaller(installerPath(), installEnvironment(installDir, mode));
  assertFailed(result, diagnostic);
  await assertNoPublishedState(installDir);
}

async function testManagedUpgrade(fault) {
  const installDir = join(temporaryRoot, `managed-${fault}`);
  assertSucceeded(await runInstaller(installerPath(), installEnvironment(installDir, "ok")), `${fault} baseline install`);
  const originalExecutable = await readFile(executablePath(installDir));
  const originalReceipt = await readFile(receiptPath(installDir));
  let selectedInstaller = installerPath();
  if (fault !== "success") {
    selectedInstaller = join(temporaryRoot, `install-${fault}.${target.os === "win32" ? "ps1" : "sh"}`);
    await writeFile(selectedInstaller, transformInstaller(await readFile(installerPath(), "utf8"), fault), target.os === "win32" ? "utf8" : { mode: 0o700 });
  }

  const environment = {
    ...installEnvironment(installDir, "ok"),
    YTM_MANAGED_UPGRADE: "1",
    YTM_CURRENT_VERSION: version,
    YTM_CURRENT_SHA256: sha256(originalExecutable),
    YTM_EXPECTED_VERSION: version,
    YTM_EXPECTED_ARCHIVE_SHA256: archiveDigest
  };
  let result;
  if (target.os === "win32") {
    const parent = await startSacrificialWindowsParent();
    environment.YTM_PARENT_PID = String(parent.pid);
    try {
      result = await runInstaller(selectedInstaller, environment);
    } finally {
      await stopChild(parent);
    }
    await waitForWindowsTerminalState(installDir, fault === "interruption");
  } else {
    result = await runInstaller(selectedInstaller, environment);
  }

  if (fault === "success") {
    assertSucceeded(result, "exact managed upgrade");
    if (target.os === "win32") {
      const status = JSON.parse(await readFile(statusPath(installDir), "utf8"));
      if (status.status !== "upgraded" || status.ok !== true) throw new Error("Windows managed upgrade did not publish upgraded status.");
      if (status.version !== version || status.target !== target.key || status.installedSha256 !== sha256(archivedExecutable)
        || status.executable !== executablePath(installDir) || status.receipt !== receiptPath(installDir)) {
        throw new Error("Windows managed upgrade status did not identify the exact installed pair.");
      }
    }
    await assertInstalledPair(installDir);
    for (const path of [previousPath(installDir), previousReceiptPath(installDir), inProgressPath(installDir)]) {
      if (await pathExists(path)) throw new Error(`successful managed upgrade left ${path}.`);
    }
    return;
  }
  if (fault === "interruption" && target.os === "win32") {
    assertSucceeded(result, "Windows interruption scheduling");
    const status = JSON.parse(await readFile(statusPath(installDir), "utf8"));
    if (status.status !== "scheduled" || status.ok !== true || status.version !== version || status.target !== target.key
      || status.executable !== executablePath(installDir) || status.receipt !== receiptPath(installDir)) {
      throw new Error("interrupted Windows upgrade did not retain its exact scheduled status.");
    }
    for (const path of [previousPath(installDir), previousReceiptPath(installDir), inProgressPath(installDir)]) {
      if (!(await pathExists(path))) throw new Error(`interrupted Windows upgrade did not preserve ${path}`);
    }
    if (!(await readFile(previousPath(installDir))).equals(originalExecutable) || !(await readFile(previousReceiptPath(installDir))).equals(originalReceipt)) {
      throw new Error("interrupted Windows upgrade did not preserve the exact prior pair as recovery evidence.");
    }
    for (const path of [executablePath(installDir), receiptPath(installDir)]) {
      if (await pathExists(path)) throw new Error(`interrupted Windows upgrade left ambiguous current state at ${path}.`);
    }
    return;
  }
  if (target.os === "win32") {
    assertSucceeded(result, `Windows ${fault} scheduling`);
    const status = JSON.parse(await readFile(statusPath(installDir), "utf8"));
    if (status.status !== "recoverableFailure") throw new Error(`${fault} did not publish recoverableFailure status.`);
    if (!String(status.reason).includes("injected")) throw new Error(`${fault} status did not retain the injected failure reason.`);
    if (status.executable !== executablePath(installDir) || status.receipt !== receiptPath(installDir)
      || status.previous !== previousPath(installDir) || status.previousReceipt !== previousReceiptPath(installDir)) {
      throw new Error(`${fault} status did not report the exact managed and recovery paths.`);
    }
    if (fault !== "restoration" && status.restored !== true) throw new Error(`${fault} did not report a completed restoration.`);
    if (fault === "restoration" && status.restored !== false) throw new Error("restoration failure did not report retained recovery state.");
  } else {
    assertFailed(result, fault === "restoration" ? "automatic rollback was incomplete" : fault === "interruption" ? "" : "injected");
  }
  if (fault === "restoration") {
    for (const path of [previousPath(installDir), previousReceiptPath(installDir)]) {
      if (!(await pathExists(path))) throw new Error(`restoration failure did not preserve ${path}.`);
    }
    for (const path of [executablePath(installDir), receiptPath(installDir)]) {
      if (await pathExists(path)) throw new Error(`restoration failure left ambiguous current state at ${path}.`);
    }
    if (!(await readFile(previousPath(installDir))).equals(originalExecutable) || !(await readFile(previousReceiptPath(installDir))).equals(originalReceipt)) {
      throw new Error("restoration failure did not retain the exact prior pair as recovery evidence.");
    }
    return;
  }
  if (!(await readFile(executablePath(installDir))).equals(originalExecutable) || !(await readFile(receiptPath(installDir))).equals(originalReceipt)) {
    throw new Error(`${fault} failure did not restore the exact prior managed pair.`);
  }
  for (const path of [previousPath(installDir), previousReceiptPath(installDir), inProgressPath(installDir)]) {
    if (await pathExists(path)) throw new Error(`${fault} completed restoration left ${path}.`);
  }
}

function transformInstaller(source, fault) {
  if (target.os !== "win32") {
    if (fault === "replacement") return replaceOnce(source, '  mv -f "$staged" "$executable"', "  printf '%s\\n' 'injected replacement failure' >&2; false", fault);
    if (fault === "receipt") return replaceOnce(source, '  mv -f "$staged_receipt" "$receipt"', "  printf '%s\\n' 'injected receipt failure' >&2; false", fault);
    if (fault === "interruption") return replaceOnce(source, '  mv -f "$staged" "$executable"', '  mv -f "$staged" "$executable"\n  kill -TERM $$ # injected interruption', fault);
    if (fault === "restoration") {
      return replaceOnce(
        replaceOnce(
          replaceOnce(source, '  mv -f "$staged_receipt" "$receipt"', "  printf '%s\\n' 'injected receipt failure' >&2; false", fault),
          '    mv -f "$previous" "$executable" || restored=\'0\'',
          '    false # injected executable restoration failure\n    restored=\'0\'',
          fault
        ),
        '    mv -f "$previous_receipt" "$receipt" || restored=\'0\'',
        '    false # injected receipt restoration failure\n    restored=\'0\'',
        fault
      );
    }
  } else {
    if (fault === "replacement") return replaceOnce(source, "      '  [IO.File]::Move($Staged, $Executable)',", "      '  throw \"injected replacement failure\"',", fault);
    if (fault === "receipt") return replaceOnce(source, "      '  [IO.File]::Move($StagedReceipt, $Receipt)',", "      '  throw \"injected receipt failure\"',", fault);
    if (fault === "interruption") return replaceOnce(source, "      '$HaveBackup = $true',", "      '$HaveBackup = $true',\n      'Stop-Process -Id $PID -Force',", fault);
    if (fault === "restoration") {
      return replaceOnce(
        replaceOnce(source, "      '  [IO.File]::Move($StagedReceipt, $Receipt)',", "      '  throw \"injected receipt failure\"',", fault),
        "      '      [IO.File]::Move($Previous, $Executable)',",
        "      '      throw \"injected restoration failure\"',",
        fault
      );
    }
  }
  throw new Error(`Unsupported ${target.os} fault ${fault}.`);
}

async function assertInstalledPair(installDir) {
  const installed = await readFile(executablePath(installDir));
  if (!installed.equals(archivedExecutable)) throw new Error("Installer did not publish the exact archived executable bytes.");
  const digest = sha256(installed);
  const expected = `schema=1\nversion=${version}\ntarget=${target.key}\nexecutable=${target.executableFile}\nrelease_source=https://github.com/${manifest.repository}/releases/download/v${version}\ninstalled_sha256=${digest}\n`;
  if (await readFile(receiptPath(installDir), "utf8") !== expected) throw new Error("Installer did not publish the exact truthful receipt.");
}

async function assertNoPublishedState(installDir) {
  for (const path of [executablePath(installDir), receiptPath(installDir), previousPath(installDir), previousReceiptPath(installDir), inProgressPath(installDir)]) {
    if (await pathExists(path)) throw new Error(`failed fresh install left state at ${path}`);
  }
}

async function waitForWindowsTerminalState(installDir, interrupted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (interrupted) {
      if (
        await pathExists(previousPath(installDir))
        && await pathExists(previousReceiptPath(installDir))
        && await pathExists(inProgressPath(installDir))
      ) return;
    } else if (await pathExists(statusPath(installDir))) {
      const status = JSON.parse(await readFile(statusPath(installDir), "utf8"));
      if (status.status !== "scheduled" && !(await pathExists(inProgressPath(installDir)))) return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Windows upgrade helper did not reach its expected terminal state.");
}

async function startSacrificialWindowsParent() {
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore" });
  await new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveClose) => child.once("close", resolveClose));
  if (!child.kill()) throw new Error(`Could not stop sacrificial parent process ${child.pid}.`);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Sacrificial parent process ${child.pid} did not exit.`)), 5_000))
  ]);
}

function installEnvironment(installDir, mode) {
  return {
    ...process.env,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    YTM_INSTALL_DIR: installDir,
    YTM_RELEASE_BASE_URL: `${releaseBase}/${mode}`
  };
}

function installerPath() {
  return join(candidate, target.os === "win32" ? manifest.installerAssets.powershell : manifest.installerAssets.shell);
}

function executablePath(directory) { return join(directory, target.executableFile); }
function receiptPath(directory) { return `${executablePath(directory)}.receipt`; }
function previousPath(directory) { return join(directory, target.os === "win32" ? ".ytm.exe.previous" : ".ytm.previous"); }
function previousReceiptPath(directory) { return join(directory, target.os === "win32" ? ".ytm.exe.receipt.previous" : ".ytm.receipt.previous"); }
function statusPath(directory) { return join(directory, ".ytm.exe.upgrade-status.json"); }
function inProgressPath(directory) { return join(directory, ".ytm.exe.upgrade-in-progress"); }

function runInstaller(path, env) {
  return target.os === "win32"
    ? runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path], env)
    : runProcess("sh", [path], env);
}

function runNode(script, args) {
  return runProcess(process.execPath, [resolve(repositoryRoot, script), ...args]);
}

function runProcess(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminationDeadline;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      terminationDeadline = setTimeout(() => reject(new Error(`${command} did not exit after its 120 second test deadline.`)), 5_000);
    }, 120_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); clearTimeout(terminationDeadline); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      if (timedOut) reject(new Error(`${command} exceeded its 120 second test deadline and exited with ${signal || status}.`));
      else resolveRun({ status, signal, stdout, stderr });
    });
  });
}

function assertSucceeded(result, operation, diagnostic = "") {
  if (result.status !== 0 || (diagnostic && !`${result.stdout}\n${result.stderr}`.includes(diagnostic))) {
    throw new Error(`${operation} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function assertFailed(result, diagnostic) {
  if (result.status === 0) throw new Error(`Expected failure containing ${diagnostic}.`);
  if (!`${result.stdout}\n${result.stderr}`.includes(diagnostic)) {
    throw new Error(`Failure did not contain ${diagnostic}:\n${result.stdout}\n${result.stderr}`);
  }
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) throw new Error(`${label} fault anchor must occur exactly once.`);
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function pathExists(path) { return access(path).then(() => true, () => false); }
