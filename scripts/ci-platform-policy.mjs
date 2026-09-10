import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cliBuildPlan, loadCliReleasePolicy } from './cli-release-policy.mjs';

// Cross-platform builds are an explicit, manual cost exception. Reusable
// workflows retain the caller's event, so automatic callers stay Linux-only.
export function needsFullPlatforms(eventName) {
  return eventName === 'workflow_dispatch';
}

export async function platformMatrices(full) {
  const { manifest, linuxBuild } = await loadCliReleasePolicy(process.cwd());
  const native = JSON.parse(readFileSync('native-targets.json', 'utf8'));
  const selected = target => full || target === 'x86_64-unknown-linux-gnu';
  const runner = (target, fallback) => target === 'x86_64-unknown-linux-gnu' ? 'blacksmith-2vcpu-ubuntu-2404' : fallback;
  return {
    matrix: { include: manifest.targets.filter(t => selected(t.rustTarget)).map(t => ({
      key: t.key, rust: t.rustTarget, runner: runner(t.rustTarget, t.runner), arch: t.arch,
      usesGlibcFloor: cliBuildPlan(manifest, linuxBuild, t.rustTarget).usesGlibcFloor
    })) },
    native: { node: native.validationNodeMajors, target: native.targets.filter(t => selected(t.rustTarget)).map(t => ({
      rust: t.rustTarget, runner: runner(t.rustTarget, t.runner), arch: t.npmArch, directory: t.packageDirectory
    })) }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const full = needsFullPlatforms(process.env.GITHUB_EVENT_NAME);
  const matrices = await platformMatrices(full);
  for (const [key, value] of Object.entries({ full, ...matrices })) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
  }
}
