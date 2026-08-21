import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/assemble-native-package.mjs <rust-target> [profile]");
const profile = process.argv[3] || "release";
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown native target: ${rustTarget}`);
const extension = target.npmPlatform === "win32" ? "dll" : target.npmPlatform === "darwin" ? "dylib" : "so";
const prefix = target.npmPlatform === "win32" ? "" : "lib";
const source = resolve(repositoryRoot, "target", rustTarget, profile, `${prefix}ytm_node.${extension}`);
const destination = resolve(repositoryRoot, manifest.nativePackageRoot, target.packageDirectory, target.artifactFile);
await copyFile(source, destination);
console.log(`${rustTarget} -> ${destination.slice(repositoryRoot.length + 1)}`);
