import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGz, createZip } from "./deterministic-archive.mjs";
import {
  assertReleaseIdentity,
  cliArchiveName,
  cliArchiveRoot,
  cliBuildPlan,
  loadCliReleasePolicy
} from "./cli-release-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [rustTarget, outputDirectoryArgument] = process.argv.slice(2);
if (!rustTarget || !outputDirectoryArgument) {
  throw new Error("Usage: node scripts/assemble-cli-archive.mjs <rust-target> <output-directory> --source-commit <sha> [--binary <path>]");
}
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const sourceCommit = option("--source-commit");
const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
assertReleaseIdentity(version, sourceCommit);
const checkout = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
if (checkout.status !== 0 || checkout.stdout.trim() !== sourceCommit) {
  throw new Error(`Archive source ${sourceCommit} does not match checkout ${checkout.stdout.trim() || "unknown"}.`);
}
const plan = cliBuildPlan(manifest, linuxBuild, rustTarget);
const binaryPath = resolve(option("--binary") || resolve(repositoryRoot, "target", plan.artifactTarget, "release", plan.artifactFileName));
const binary = await readFile(binaryPath);
assertExecutableFormat(plan.target, binary);

const root = cliArchiveRoot(manifest, plan.target, version);
const entries = [
  { name: `${root}/${plan.target.executableFile}`, mode: 0o755, contents: binary },
  ...await Promise.all(manifest.licenseFiles.map(async (file) => ({
    name: `${root}/${file}`,
    mode: 0o644,
    contents: await readFile(resolve(repositoryRoot, file))
  })))
];
const archive = plan.target.archiveFormat === "zip" ? createZip(entries) : createTarGz(entries);
const archiveName = cliArchiveName(manifest, plan.target, version);
const outputDirectory = resolve(outputDirectoryArgument);
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, archiveName), archive);
const digest = createHash("sha256").update(archive).digest("hex");
await writeFile(resolve(outputDirectory, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`, "utf8");
console.log(`${rustTarget} -> ${archiveName} (${digest})`);

function assertExecutableFormat(target, binary) {
  const expected = target.os === "linux"
    ? binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    : target.os === "darwin"
      ? new Set([0xfeedfacf, 0xcffaedfe]).has(binary.readUInt32BE(0))
      : binary.subarray(0, 2).toString("ascii") === "MZ";
  if (!expected) throw new Error(`${target.key} executable does not match its declared binary format.`);
}
