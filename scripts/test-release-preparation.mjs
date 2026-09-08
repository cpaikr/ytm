import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "ytm-preparation-test-"));
const fixture = join(temporary, "repository");
const remote = join(temporary, "remote.git");
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = sourcePackage.version;
const nextVersion = version.split('.').map((part, index) => index === 2 ? Number(part) + 1 : part).join('.');
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_AUTHOR_NAME: "Release fixture", GIT_AUTHOR_EMAIL: "release@example.invalid",
  GIT_COMMITTER_NAME: "Release fixture", GIT_COMMITTER_EMAIL: "release@example.invalid",
};
const run = (command, args, success = true) => {
  const result = spawnSync(command, args, { cwd: fixture, env: gitEnvironment, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (success) assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  else assert.notEqual(result.status, 0, 'injected validation failure must stop preparation');
  return result.stdout.trim();
};
const put = async (path, contents) => {
  const destination = join(fixture, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
};
try {
  await mkdir(fixture);
  for (const path of [
    'VERSION', 'CHANGELOG.md', 'rust-toolchain.toml', 'bun.lock', 'native-targets.json', 'LICENSE.md', 'THIRD_PARTY_LICENSES.html',
    'packages/node/package.json', 'packages/python/pyproject.toml',
    'scripts/release-version.mjs', 'scripts/validate-product-version.mjs',
    'scripts/generate-native-packages.mjs', 'scripts/native-build-policy.mjs',
  ]) {
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await copyFile(join(root, path), join(fixture, path));
  }
  const targets = JSON.parse(await readFile(join(fixture, 'native-targets.json'), 'utf8'));
  for (const target of targets.targets) {
    const path = `${targets.nativePackageRoot}/${target.packageDirectory}/package.json`;
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await copyFile(join(root, path), join(fixture, path));
  }
  // Use dependency-free Rust consumers so this lifecycle regression requires no
  // toolchain downloads or compilation. The real version sync script owns updates.
  const members = ['ytm-core', 'ytm-cli', 'ytm-node', 'ytm-python'];
  await put('Cargo.toml', `[workspace]\nmembers = ${JSON.stringify(members.map(name => `crates/${name}`))}\nresolver = "2"\n\n[workspace.package]\nversion = "${version}"\n`);
  for (const name of members) {
    await put(`crates/${name}/Cargo.toml`, `[package]\nname = "${name}"\nversion.workspace = true\nedition = "2021"\n${name === 'ytm-core' ? '' : `\n[dependencies]\nytm-core = { version = "=${version}", path = "../ytm-core" }\n`}`);
    await put(`crates/${name}/src/lib.rs`, '// Release preparation fixture.\n');
  }
  await put('tests/rust-sdk-consumer/Cargo.toml', `[package]\nname = "consumer"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\nytm-core = { version = "=${version}", path = "../../crates/ytm-core" }\n`);
  await put('tests/rust-sdk-consumer/src/lib.rs', '// Exact-version downstream fixture.\n');
  await put('.gitignore', 'node_modules/\ntarget/\n');
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  run('cargo', ['metadata', '--offline', '--format-version', '1']);
  run('cargo', ['metadata', '--offline', '--format-version', '1', '--manifest-path', 'tests/rust-sdk-consumer/Cargo.toml']);

  // Keep the production hook name and sync command. Only substitute the expensive
  // whole-product gate; its marker must land in the same release commit as the bump.
  const hooks = sourcePackage['release-it'].hooks;
  const preparationHook = Object.keys(hooks).find(name => Array.isArray(hooks[name]) && hooks[name].includes('node scripts/release-version.mjs sync'));
  assert.ok(preparationHook, 'production version synchronization hook is missing');
  hooks[preparationHook] = hooks[preparationHook].map(command => command === 'bun run validate' ? 'node scripts/fixture-validation.mjs' : command);
  await put('package.json', `${JSON.stringify(sourcePackage, null, 2)}\n`);
  await put('validation-marker', 'not yet validated\n');
  await put('scripts/fixture-validation.mjs', `import {execFileSync} from 'node:child_process';\nimport {readFileSync,writeFileSync} from 'node:fs';\nexecFileSync(process.execPath,['scripts/validate-product-version.mjs'],{stdio:'inherit'});\nif(process.env.YTM_TEST_FAIL_VALIDATION) process.exit(23);\nwriteFileSync('validation-marker',readFileSync('VERSION'));\n`);
  run(process.execPath, ['scripts/generate-native-packages.mjs']);
  run('git', ['init', '-b', 'main']);
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'chore: release fixture']);
  run('git', ['tag', `v${version}`]);
  run('git', ['init', '--bare', remote]);
  run('git', ['remote', 'add', 'origin', remote]);
  run('git', ['push', '-u', 'origin', 'main', '--tags']);
  await put('fixture-change', 'release change\n');
  run('git', ['add', 'fixture-change']);
  run('git', ['commit', '-m', 'fix: certify preparation order']);
  run('git', ['push']);
  const previousHead = run('git', ['rev-parse', 'HEAD']);
  const lockedPackages = parseYaml(await readFile(join(fixture, 'bun.lock'), 'utf8')).packages;
  const release = [join(root, 'node_modules/release-it/bin/release-it.js'), 'patch', '--ci'];

  gitEnvironment.YTM_TEST_FAIL_VALIDATION = '1';
  run(process.execPath, release, false);
  assert.equal(run('git', ['rev-parse', 'HEAD']), previousHead);
  assert.equal(run('git', ['rev-parse', 'origin/main']), previousHead);
  assert.equal(run('git', ['tag', '--list']), `v${version}`, 'failed validation must create no release tag');
  // Only discard the deliberately failed bump in this disposable fixture.
  run('git', ['reset', '--hard', 'HEAD']);
  delete gitEnvironment.YTM_TEST_FAIL_VALIDATION;
  run(process.execPath, release);
  assert.equal(run('git', ['status', '--porcelain']), '', 'all synchronized files and validation changes must be committed');
  assert.equal(run('git', ['show', `v${nextVersion}:VERSION`]), nextVersion);
  assert.equal(run('git', ['show', `v${nextVersion}:validation-marker`]), nextVersion, 'validation must precede Git staging');
  assert.equal(run('git', ['rev-parse', 'HEAD']), run('git', ['rev-parse', 'origin/main']), 'release-it must push the release commit to the fixture remote');
  run(process.execPath, ['scripts/release-version.mjs', 'check', `v${nextVersion}`]);
  assert.deepEqual(parseYaml(await readFile(join(fixture, 'bun.lock'), 'utf8')).packages, lockedPackages, 'a version bump must preserve all resolved dependencies');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log('Real release-it preparation synchronizes versions before staging; failed validation creates no commit, tag, or push');
