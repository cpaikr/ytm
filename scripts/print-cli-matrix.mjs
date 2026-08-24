import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuildPlan, loadCliReleasePolicy } from "./cli-release-policy.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { manifest, linuxBuild } = await loadCliReleasePolicy(repositoryRoot);
console.log(JSON.stringify({ include: manifest.targets.map((target) => {
  const plan = cliBuildPlan(manifest, linuxBuild, target.rustTarget);
  return {
    key: target.key,
    rust: target.rustTarget,
    runner: target.runner,
    arch: target.arch,
    usesGlibcFloor: plan.usesGlibcFloor
  };
}) }));
