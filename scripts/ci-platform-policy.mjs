import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cliBuildPlan, loadCliReleasePolicy } from './cli-release-policy.mjs';

// Native code, bindings, installers, build configuration and test harnesses can
// change OS/architecture behavior. Documentation-only development stays cheap.
export function needsFullPlatforms(eventName, event, changedPaths = []) {
  if (eventName === 'workflow_dispatch' || eventName === 'merge_group') return true;
  if (eventName !== 'pull_request') return false;
  if (event.pull_request.base.ref !== 'dev') return true;
  return changedPaths.some(path => /^(crates\/|packages\/|scripts\/|tests\/|judge\/|\.github\/|Cargo\.|rust-toolchain|.*-targets\.json$|package\.json$|bun\.lock$|VERSION$)/.test(path));
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
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let paths = [];
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && event.pull_request.base.ref === 'dev') {
    // Full history includes both sides of the checked-out PR merge commit.
    paths = execFileSync('git', ['diff', '--name-only', '-z', `${event.pull_request.base.sha}...${event.pull_request.head.sha}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
  }
  const full = needsFullPlatforms(process.env.GITHUB_EVENT_NAME, event, paths);
  const matrices = await platformMatrices(full);
  for (const [key, value] of Object.entries({ full, ...matrices })) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(value)}\n`);
  }
}
