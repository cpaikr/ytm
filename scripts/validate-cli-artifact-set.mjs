import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArchiveName, loadCliReleasePolicy } from "./cli-release-policy.mjs";
import { parseChecksumFile, validateCliArchive } from "./cli-artifact-validation.mjs";
import { generatePowerShellInstaller, generateShellInstaller } from "./generate-cli-installers.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/validate-cli-artifact-set.mjs <artifact-directory>");
const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const archives = manifest.targets.map((target) => cliArchiveName(manifest, target, version));
const expectedFiles = [...archives, manifest.installerAssets.shell, manifest.installerAssets.powershell, manifest.checksumFile].sort();
const directoryEntries = await readdir(directory, { withFileTypes: true });
const nonFiles = directoryEntries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
if (nonFiles.length > 0) throw new Error(`CLI artifact set contains non-file entries: ${nonFiles.join(", ")}.`);
const actualFiles = directoryEntries.map((entry) => entry.name).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`CLI artifact set must be exactly ${expectedFiles.join(", ")}; received ${actualFiles.join(", ")}.`);
}
const checksums = parseChecksumFile(await readFile(resolve(directory, manifest.checksumFile), "utf8"));
const checksumAssets = [...archives, manifest.installerAssets.shell, manifest.installerAssets.powershell].sort();
if (JSON.stringify([...checksums.keys()]) !== JSON.stringify(checksumAssets)) {
  throw new Error(`Checksum file must cover exactly ${checksumAssets.join(", ")}.`);
}
for (const asset of checksumAssets) {
  const digest = createHash("sha256").update(await readFile(resolve(directory, asset))).digest("hex");
  if (checksums.get(asset) !== digest) throw new Error(`Checksum mismatch for ${asset}.`);
}
for (const target of manifest.targets) {
  await validateCliArchive({ repositoryRoot, directory, manifest, target, version, checksums });
}
const archiveDigests = new Map(archives.map((archive) => [archive, checksums.get(archive)]));
const expectedInstallers = new Map([
  [manifest.installerAssets.shell, generateShellInstaller(manifest, version, archiveDigests, linuxBuild)],
  [manifest.installerAssets.powershell, generatePowerShellInstaller(manifest, version, archiveDigests)]
]);
for (const [asset, expected] of expectedInstallers) {
  const actual = await readFile(resolve(directory, asset), "utf8");
  if (actual !== expected) throw new Error(`${asset} is not the deterministic output of cli-targets.json.`);
}
console.log(`validated complete CLI artifact set for ${manifest.targets.length} targets at v${version}`);
