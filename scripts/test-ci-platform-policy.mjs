import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { needsFullPlatforms, platformMatrices } from './ci-platform-policy.mjs';
const pr = ref => ({ pull_request: { base: { ref } } });
assert.equal(needsFullPlatforms('pull_request', pr('main'), ['README.md']), false);
assert.equal(needsFullPlatforms('merge_group', {}), false);
assert.equal(needsFullPlatforms('workflow_dispatch', {}), true);
assert.equal(needsFullPlatforms('push', { ref: 'refs/heads/main' }), false);
assert.equal(needsFullPlatforms('pull_request', pr('dev'), ['docs/release.md']), false);
for (const path of ['crates/ytm-cli/src/main.rs', 'packages/python/pyproject.toml', 'scripts/install.sh', '.github/workflows/ci.yml', 'Cargo.lock', 'native-targets.json']) {
  assert.equal(needsFullPlatforms('pull_request', pr('dev'), [path]), false, path);
}
const full = await platformMatrices(true);
const linux = await platformMatrices(false);
assert.deepEqual(full.matrix.include.map(t => t.rust), JSON.parse(readFileSync('cli-targets.json')).targets.map(t => t.rustTarget));
assert.deepEqual(full.native.target.map(t => t.rust), JSON.parse(readFileSync('native-targets.json')).targets.map(t => t.rustTarget));
assert.deepEqual(linux.matrix.include.map(t => t.rust), ['x86_64-unknown-linux-gnu']);
assert.deepEqual(linux.native.target.map(t => t.rust), ['x86_64-unknown-linux-gnu']);
assert.equal(linux.matrix.include[0].runner, 'blacksmith-2vcpu-ubuntu-2404');
console.log('CI platform policy covers integration, development, queue, dispatch and manifest identity');

// Execute the actual aggregate step, including failed/skipped positive controls.
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const gate = workflow.jobs['platform-gate'];
for (const full of [true, false]) {
  const needs = Object.fromEntries(gate.needs.map(name => [name, {
    result: !full && ['cli-artifact-set', 'cli-consumer', 'python-candidate'].includes(name) ? 'skipped' : 'success',
    outputs: name === 'cli-metadata' ? { full: String(full) } : {}
  }]));
  const run = state => spawnSync('bash', ['-c', gate.steps[0].run], {
    env: { ...process.env, NEEDS_JSON: JSON.stringify(state) }, encoding: 'utf8'
  });
  assert.equal(run(needs).status, 0);
  for (const name of gate.needs) {
    const failed = structuredClone(needs);
    failed[name].result = 'failure';
    assert.notEqual(run(failed).status, 0, `${name} failure must block`);
    if (needs[name].result === 'success') {
      failed[name].result = 'skipped';
      assert.notEqual(run(failed).status, 0, `${name} unexpected skip must block`);
    }
  }
}
console.log('Actual aggregate gate rejects failed and unexpectedly skipped prerequisites');

const manualCandidate = parse(readFileSync('.github/workflows/cross-platform-candidate.yml', 'utf8'));
assert.equal(manualCandidate.jobs.candidate.uses, './.github/workflows/ci.yml');
assert.ok('workflow_call' in workflow.on);
assert.deepEqual(Object.keys(manualCandidate.on), ['workflow_dispatch']);
const release = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
assert.deepEqual(Object.keys(release.on), ['workflow_dispatch']);
assert.equal(linux.native.target[0].runner, 'blacksmith-2vcpu-ubuntu-2404');
// Every automatically reachable fixed runner is the cheap Linux x64 runner.
for (const file of ['ci.yml', 'live-smoke.yml']) {
  const automatic = parse(readFileSync(`.github/workflows/${file}`, 'utf8'));
  for (const job of Object.values(automatic.jobs)) {
    const runner = job['runs-on'];
    if (runner && !runner.startsWith('${{')) assert.equal(runner, 'blacksmith-2vcpu-ubuntu-2404');
  }
}
assert.equal(workflow.jobs['python-candidate'].if, "needs.cli-metadata.outputs.full == 'true'");
// Called workflows retain their caller's event, so manual dispatch selects full coverage.
assert.equal(needsFullPlatforms('workflow_dispatch', { inputs: {} }), true);

// Exercise the real process-to-Actions boundary, not just the exported policy.
const outputDirectory = mkdtempSync(join(tmpdir(), 'ytm-ci-outputs-'));
try {
  for (const [eventName, event, expectedFull] of [
    ['pull_request', pr('main'), false],
    ['pull_request', pr('dev'), false],
    ['merge_group', {}, false],
    ['push', { ref: 'refs/tags/v0.4.1' }, false],
    ['workflow_dispatch', {}, true],
    ['push', { ref: 'refs/heads/dev' }, false]
  ]) {
    const eventPath = join(outputDirectory, 'event.json');
    const outputPath = join(outputDirectory, 'outputs');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, '');
    const result = spawnSync(process.execPath, ['scripts/ci-platform-policy.mjs'], {
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const outputs = Object.fromEntries(lines.map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
    }));
    assert.deepEqual(Object.keys(outputs).sort(), ['full', 'matrix', 'native']);
    assert.equal(outputs.full, expectedFull);
    const expected = expectedFull ? full : linux;
    assert.deepEqual(outputs.matrix, expected.matrix);
    assert.deepEqual(outputs.native, expected.native);
  }
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
console.log('Policy process emits complete parseable Actions outputs for full and reduced coverage');
