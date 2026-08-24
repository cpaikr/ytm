import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { cliArchiveName, loadCliReleasePolicy, validateCliManifest } from "./cli-release-policy.mjs";
import { createTarGz, readTarGz } from "./deterministic-archive.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const sourceCommit = run("git", ["rev-parse", "HEAD"], repositoryRoot).stdout.trim();
const temporaryRoot = await mkdtemp(join(tmpdir(), "ytm-cli-release-test-"));

try {
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
  if (process.platform !== "win32") {
    run("sh", ["-n", join(first, manifest.installerAssets.shell)], repositoryRoot);
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

function run(command, args, cwd, requireSuccess = true) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
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
