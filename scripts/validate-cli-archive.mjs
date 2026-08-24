import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArchiveName, loadCliReleasePolicy } from "./cli-release-policy.mjs";
import { parseChecksumFile, validateCliArchive } from "./cli-artifact-validation.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [rustTarget, directoryArgument] = process.argv.slice(2);
if (!rustTarget || !directoryArgument) {
  throw new Error("Usage: node scripts/validate-cli-archive.mjs <rust-target> <artifact-directory> [--execute]");
}
const directory = resolve(directoryArgument);
const { manifest } = await loadCliReleasePolicy(repositoryRoot);
const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown CLI target: ${rustTarget}`);
const version = (await readFile(resolve(repositoryRoot, "VERSION"), "utf8")).trim();
const archiveName = cliArchiveName(manifest, target, version);
const sidecar = await readFile(resolve(directory, `${archiveName}.sha256`), "utf8");
const result = await validateCliArchive({
  repositoryRoot,
  directory,
  manifest,
  target,
  version,
  checksums: parseChecksumFile(sidecar),
  execute: process.argv.includes("--execute")
});
console.log(`validated ${result.archiveName} (${result.digest})`);
