import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBuildPlan } from "./native-build-policy.mjs";
import { validateElfGlibcFloor } from "./elf-glibc-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustTarget = process.argv[2];
if (!rustTarget) throw new Error("Usage: node scripts/validate-native-artifact.mjs <rust-target>");

const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "native-targets.json"), "utf8"));
const target = manifest.targets.find((candidate) => candidate.rustTarget === rustTarget);
if (!target) throw new Error(`Unknown native target: ${rustTarget}`);
if (target.npmPlatform !== "linux" || target.libc !== "glibc") {
  throw new Error(`${rustTarget} is not a Linux GNU target with a glibc floor.`);
}

const plan = nativeBuildPlan(manifest, rustTarget);
const artifactPath = resolve(
  repositoryRoot,
  "target",
  plan.artifactTarget,
  "release",
  plan.artifactFileName
);
const result = await validateElfGlibcFloor(artifactPath, manifest.linuxNativeBuild?.glibcFloor);
console.log(`${rustTarget} artifact requires at most GLIBC_${result.highest} (floor GLIBC_${result.floor})`);
