import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { cliArchiveName, loadCliReleasePolicy } from "./cli-release-policy.mjs";

if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: node scripts/plan-cli-release-upload.mjs <candidate-directory> <downloaded-release-directory>");
}
const candidateDirectory = resolve(process.argv[2]);
const releaseDirectory = resolve(process.argv[3]);
const { manifest } = await loadCliReleasePolicy(process.cwd());
const version = (await readFile("VERSION", "utf8")).trim();
const expected = [
  ...manifest.targets.map((target) => cliArchiveName(manifest, target, version)),
  manifest.installerAssets.shell,
  manifest.installerAssets.powershell,
  manifest.checksumFile,
].sort();
const candidate = await files(candidateDirectory, "candidate");
if (JSON.stringify(candidate) !== JSON.stringify(expected)) {
  throw new Error(`CLI candidate files must be exactly ${expected.join(", ")}; received ${candidate.join(", ")}.`);
}
const existing = await files(releaseDirectory, "downloaded release");
const unexpected = existing.filter((name) => !expected.includes(name));
if (unexpected.length > 0) throw new Error(`Draft Release contains unexpected assets: ${unexpected.join(", ")}.`);
for (const name of existing) {
  const [local, remote] = await Promise.all([
    readFile(resolve(candidateDirectory, name)),
    readFile(resolve(releaseDirectory, name)),
  ]);
  if (!local.equals(remote)) throw new Error(`Draft Release asset ${name} does not match the rebuilt candidate.`);
}
console.log(JSON.stringify({ missing: expected.filter((name) => !existing.includes(name)) }));

async function files(directory, label) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (nonFiles.length > 0) throw new Error(`${label} contains non-file entries: ${nonFiles.join(", ")}.`);
  return entries.map((entry) => entry.name).sort();
}
