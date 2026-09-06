import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { needsFullPlatforms, platformMatrices } from './ci-platform-policy.mjs';
const pr = ref => ({ pull_request: { base: { ref } } });
assert.equal(needsFullPlatforms('pull_request', pr('main'), ['README.md']), true);
assert.equal(needsFullPlatforms('merge_group', {}), true);
assert.equal(needsFullPlatforms('workflow_dispatch', {}), true);
assert.equal(needsFullPlatforms('push', { ref: 'refs/heads/main' }), false);
assert.equal(needsFullPlatforms('pull_request', pr('dev'), ['docs/release.md']), false);
for (const path of ['crates/ytm-cli/src/main.rs', 'packages/python/pyproject.toml', 'scripts/install.sh', '.github/workflows/ci.yml', 'Cargo.lock', 'native-targets.json']) {
  assert.equal(needsFullPlatforms('pull_request', pr('dev'), [path]), true, path);
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
