import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuildPlan, loadCliReleasePolicy } from "./cli-release-policy.mjs";
import { validateElfGlibcFloor } from "./elf-glibc-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/validate-cli-glibc.mjs <rust-target>");
const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
const plan = cliBuildPlan(manifest, linuxBuild, rustTarget);
if (!plan.usesGlibcFloor) throw new Error(`${rustTarget} is not a Linux GNU CLI target.`);
const artifact = resolve(repositoryRoot, "target", plan.artifactTarget, "release", plan.artifactFileName);
const result = await validateElfGlibcFloor(artifact, linuxBuild.glibcFloor);
console.log(`${rustTarget} CLI requires at most GLIBC_${result.highest} (floor GLIBC_${result.floor})`);
