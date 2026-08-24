import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliArchiveName, expectedArchiveEntries } from "./cli-release-policy.mjs";
import { createTarGz, createZip, readTarGz, readZip } from "./deterministic-archive.mjs";

export async function validateCliArchive({ repositoryRoot, directory, manifest, target, version, checksums, execute = false }) {
  const archiveName = cliArchiveName(manifest, target, version);
  const archive = await readFile(resolve(directory, archiveName));
  const digest = createHash("sha256").update(archive).digest("hex");
  if (checksums.get(archiveName) !== digest) throw new Error(`Checksum mismatch for ${archiveName}.`);
  const entries = target.archiveFormat === "zip" ? readZip(archive) : readTarGz(archive);
  const names = entries.map(({ name }) => name);
  const expectedNames = expectedArchiveEntries(manifest, target, version).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`${archiveName} entries must be exactly ${expectedNames.join(", ")}; received ${names.join(", ")}.`);
  }
  if (new Set(names).size !== names.length || names.some(unsafeArchivePath)) {
    throw new Error(`${archiveName} contains duplicate or unsafe paths.`);
  }
  const canonicalEntries = entries.map((entry) => ({
    name: entry.name,
    mode: entry.name.endsWith(`/${target.executableFile}`) ? 0o755 : 0o644,
    contents: entry.contents
  }));
  const canonicalArchive = target.archiveFormat === "zip" ? createZip(canonicalEntries) : createTarGz(canonicalEntries);
  if (!archive.equals(canonicalArchive)) throw new Error(`${archiveName} is not the canonical deterministic archive for its entries.`);
  const root = names[0].split("/")[0];
  for (const license of manifest.licenseFiles) {
    const archived = entries.find(({ name }) => name === `${root}/${license}`)?.contents;
    const canonical = await readFile(resolve(repositoryRoot, license));
    if (!archived?.equals(canonical)) throw new Error(`${archiveName} does not contain the canonical ${license}.`);
  }
  const executable = entries.find(({ name }) => name === `${root}/${target.executableFile}`);
  if (!executable) throw new Error(`${archiveName} does not contain ${target.executableFile}.`);
  if (target.archiveFormat === "tar.gz" && executable.mode !== 0o755) {
    throw new Error(`${archiveName} executable mode must be 0755.`);
  }
  assertExecutableArchitecture(target, executable.contents);
  if (execute) await executeIdentity(target, executable.contents, version);
  return { archiveName, digest };
}

export function parseChecksumFile(contents) {
  const checksums = new Map();
  const lines = contents.split("\n");
  if (lines.at(-1) !== "") throw new Error("Checksum file must end with LF.");
  lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum line ${JSON.stringify(line)}.`);
    if (checksums.has(match[2])) throw new Error(`Duplicate checksum for ${match[2]}.`);
    checksums.set(match[2], match[1]);
  }
  if (JSON.stringify([...checksums.keys()]) !== JSON.stringify([...checksums.keys()].sort())) {
    throw new Error("Checksum entries must be sorted by asset name.");
  }
  return checksums;
}

function unsafeArchivePath(name) {
  return name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "" || part === "." || part === "..");
}

function assertExecutableArchitecture(target, binary) {
  if (target.os === "linux") {
    if (binary.length < 20 || !binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || binary[5] !== 1) {
      throw new Error(`${target.key} executable is not a little-endian ELF binary.`);
    }
    const expectedMachine = target.arch === "x64" ? 62 : 183;
    if (binary.readUInt16LE(18) !== expectedMachine) throw new Error(`${target.key} ELF machine does not match ${target.arch}.`);
    return;
  }
  if (target.os === "darwin") {
    if (binary.length < 8 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) {
      throw new Error(`${target.key} executable is not a Mach-O ARM64 binary.`);
    }
    return;
  }
  if (binary.length < 70 || binary.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error(`${target.key} executable is not a PE binary.`);
  }
  const peOffset = binary.readUInt32LE(0x3c);
  if (peOffset + 6 > binary.length || binary.subarray(peOffset, peOffset + 4).toString("latin1") !== "PE\0\0" || binary.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error(`${target.key} executable is not a PE x64 binary.`);
  }
}

async function executeIdentity(target, binary, version) {
  const expectedPlatform = target.os === "win32" ? "win32" : target.os;
  if (process.platform !== expectedPlatform || process.arch !== target.arch) {
    throw new Error(`Cannot execute ${target.key} on ${process.platform}-${process.arch}.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "ytm-cli-identity-"));
  const executable = join(directory, target.executableFile);
  try {
    await writeFile(executable, binary);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    for (const [args, expected] of [
      [["--version"], `ytm ${version}\n`],
      [["--help"], "CLI usage:"]
    ]) {
      const result = spawnSync(executable, args, { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0 || result.stderr !== "" || (expected.endsWith("\n") ? result.stdout !== expected : !result.stdout.includes(expected))) {
        throw new Error(`${target.key} executable failed ${args.join(" ")} identity validation.`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
