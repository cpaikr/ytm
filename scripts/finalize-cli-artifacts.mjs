import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArchiveName, loadCliReleasePolicy } from "./cli-release-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/finalize-cli-artifacts.mjs <artifact-directory>");
const { manifest } = await loadCliReleasePolicy(repositoryRoot);
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const expectedArchives = manifest.targets.map((target) => cliArchiveName(manifest, target, version)).sort();
const actualFiles = await readdir(directory);
for (const archive of expectedArchives) {
  if (!actualFiles.includes(archive)) throw new Error(`Missing CLI archive ${archive}.`);
  const sidecar = `${archive}.sha256`;
  if (!actualFiles.includes(sidecar)) throw new Error(`Missing CLI checksum sidecar ${sidecar}.`);
  const digest = createHash("sha256").update(await readFile(resolve(directory, archive))).digest("hex");
  const recorded = await readFile(resolve(directory, sidecar), "utf8");
  if (recorded !== `${digest}  ${archive}\n`) throw new Error(`Checksum sidecar for ${archive} is invalid.`);
}
const checksumAssets = [...expectedArchives, manifest.installerAssets.shell, manifest.installerAssets.powershell].sort();
const lines = [];
for (const asset of checksumAssets) {
  const bytes = await readFile(resolve(directory, asset));
  lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${asset}`);
}
await writeFile(resolve(directory, manifest.checksumFile), `${lines.join("\n")}\n`, "utf8");
await Promise.all(expectedArchives.map((archive) => rm(resolve(directory, `${archive}.sha256`))));
console.log(`finalized ${expectedArchives.length} CLI archives and ${checksumAssets.length} checksums`);
