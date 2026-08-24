import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { approvedReleasePullRequest, canonicalReleaseUrl, classifyReleaseState, expectedReleaseTag } from "./release-state-policy.mjs";
import { releaseMetadataFromChangelog } from "./release-metadata-policy.mjs";
import { cliArchiveName, loadCliReleasePolicy } from "./cli-release-policy.mjs";

const sha = "1".repeat(40);
const otherSha = "2".repeat(40);
const releaseName = "v1.2.3";
const releaseBody = "### Features\n\n- exact release\n";
const draft = { id: 7, tag_name: "v1.2.3", name: releaseName, body: releaseBody, draft: true, prerelease: false, html_url: "https://github.com/example/ytm/releases/untagged-abc123" };
const state = (overrides = {}) => ({
  expectedVersion: "1.2.3",
  workflowRef: "refs/heads/main",
  workflowSha: sha,
  mainSha: sha,
  tagSha: null,
  releases: [],
  expectedReleaseName: releaseName,
  expectedReleaseBody: releaseBody,
  ...overrides,
});

assert.equal(expectedReleaseTag("1.2.3"), "v1.2.3");
assert.throws(() => expectedReleaseTag("1.2.3-rc.1"), /stable SemVer/);
assert.equal(canonicalReleaseUrl("https://github.com/", "example/ytm", "v1.2.3"), "https://github.com/example/ytm/releases/tag/v1.2.3");
const releasePull = {
  number: 42,
  title: "chore(main): release 1.2.3",
  merged_at: "2026-08-25T00:00:00Z",
  merge_commit_sha: sha,
  base: { ref: "main" },
  head: { ref: "release-please--branches--main--components--ytm" },
  labels: [{ name: "autorelease: pending" }],
};
assert.equal(approvedReleasePullRequest([releasePull], "1.2.3", sha).number, 42);
assert.throws(() => approvedReleasePullRequest([{ ...releasePull, merge_commit_sha: otherSha }], "1.2.3", sha), /unique merged Release Please PR/);
assert.throws(() => approvedReleasePullRequest([{ ...releasePull, title: "ordinary main change" }], "1.2.3", sha), /unique merged Release Please PR/);
assert.deepEqual(releaseMetadataFromChangelog(`# Changelog\n\n## [1.2.3](https://example.test) (2026-08-25)\n\n${releaseBody}\n## [1.2.2](https://example.test)\n\nold\n`, "1.2.3"), { tag: "v1.2.3", name: releaseName, body: releaseBody });
assert.equal(classifyReleaseState(state()).mode, "create");
assert.equal(classifyReleaseState(state({ tagSha: sha })).mode, "create_draft");
assert.equal(classifyReleaseState(state({ tagSha: sha, releases: [draft] })).mode, "resume");
assert.equal(classifyReleaseState(state({ workflowRef: "refs/tags/v1.2.3", mainSha: otherSha, tagSha: sha, releases: [draft] })).mode, "resume");
assert.equal(classifyReleaseState(state({ workflowRef: "refs/tags/v1.2.3", mainSha: otherSha, tagSha: sha, releases: [{ ...draft, draft: false }] })).mode, "project");
for (const [input, message] of [
  [state({ workflowRef: "refs/tags/v1.2.3" }), /dispatched from main/],
  [state({ releases: [draft] }), /without its immutable tag/],
  [state({ tagSha: sha, releases: [{ ...draft, name: "edited" }] }), /name does not match/],
  [state({ tagSha: sha, releases: [{ ...draft, body: "edited\n" }] }), /body does not match/],
  [state({ workflowSha: otherSha, mainSha: otherSha, tagSha: sha, releases: [draft] }), /does not match tagged source/],
  [state({ mainSha: otherSha, tagSha: sha, releases: [draft] }), /main has advanced/],
]) {
  assert.throws(() => classifyReleaseState(input), message);
}

const temporary = await mkdtemp(resolve(tmpdir(), "ytm-release-publication-"));
try {
  const candidate = resolve(temporary, "candidate");
  const remote = resolve(temporary, "remote");
  await Promise.all([mkdir(candidate), mkdir(remote)]);
  const { manifest } = await loadCliReleasePolicy(process.cwd());
  const version = (await readFile("VERSION", "utf8")).trim();
  const expected = [
    ...manifest.targets.map((target) => cliArchiveName(manifest, target, version)),
    manifest.installerAssets.shell,
    manifest.installerAssets.powershell,
    manifest.checksumFile,
  ].sort();
  for (const name of expected) await writeFile(resolve(candidate, name), `candidate:${name}\n`);
  for (const name of expected.slice(0, 2)) await writeFile(resolve(remote, name), `candidate:${name}\n`);

  const plan = JSON.parse(runUploadPlan(candidate, remote).stdout);
  assert.deepEqual(plan.missing, expected.slice(2));

  await writeFile(resolve(remote, expected[0]), "mismatch\n");
  assert.match(runUploadPlan(candidate, remote, false).stderr, /does not match the rebuilt candidate/);
  await writeFile(resolve(remote, expected[0]), `candidate:${expected[0]}\n`);
  await writeFile(resolve(remote, "unexpected.txt"), "unexpected\n");
  assert.match(runUploadPlan(candidate, remote, false).stderr, /unexpected assets/);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log("release publication state and asset recovery policy passed");

function runUploadPlan(candidate, remote, success = true) {
  const result = spawnSync(process.execPath, ["scripts/plan-cli-release-upload.mjs", candidate, remote], { encoding: "utf8" });
  if (success && result.status !== 0) throw new Error(result.stderr);
  if (!success && result.status === 0) throw new Error("Expected release upload planning to fail.");
  return result;
}
