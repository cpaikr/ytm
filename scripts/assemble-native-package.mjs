import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBuildPlan } from "./native-build-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/assemble-native-package.mjs <rust-target> [profile]");
const profile = process.argv[3] || "release";
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const buildPlan = nativeBuildPlan(manifest, rustTarget);
const target = buildPlan.target;
const source = resolve(repositoryRoot, "target", buildPlan.artifactTarget, profile, buildPlan.artifactFileName);
const destination = resolve(repositoryRoot, manifest.nativePackageRoot, target.packageDirectory, target.artifactFile);
await copyFile(source, destination);
console.log(`${rustTarget} -> ${destination.slice(repositoryRoot.length + 1)}`);
