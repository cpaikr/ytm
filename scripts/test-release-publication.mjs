import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { publishRelease } from "./publish-release.mjs";
import { expectedReleaseTag, normalizeReleaseBody, releaseMetadataFromChangelog } from "./release-metadata-policy.mjs";

const sourceCommit = "1".repeat(40);
const metadata = { tag: "v1.2.3", name: "v1.2.3", body: "### Features\n\n- exact release\n" };
const files = ["ytm-v1.2.3-linux-x64-gnu.tar.gz", "install.sh", "SHA256SUMS"];
const temporary = await mkdtemp(resolve(tmpdir(), "ytm-publication-test-"));
const bytes = Object.fromEntries(files.map(name => [name, Buffer.from(`candidate:${name}\n`)]));
const completed = { isDraft: false, isPrerelease: false, tagName: metadata.tag, name: metadata.name, body: metadata.body };

assert.equal(expectedReleaseTag("1.2.3"), "v1.2.3");
for (const version of ["01.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2", "../1.2.3"]) assert.throws(() => expectedReleaseTag(version), /stable SemVer/);
assert.equal(normalizeReleaseBody("line one\r\nline two\r\n"), "line one\nline two\n");
for (const heading of ["## [1.2.3](https://example.test) (2026-09-08)", "## 1.2.3 (2026-09-08)", "# [1.2.3](https://example.test) (2026-09-08)"]) {
  assert.deepEqual(releaseMetadataFromChangelog(`# Changelog\n\n${heading}\n\n${metadata.body}\n## [1.2.2](https://example.test)\n\nold\n`, "1.2.3"), metadata);
}
assert.throws(() => releaseMetadataFromChangelog("## 1.2.2\nold\n", "1.2.3"), /first changelog release/);
assert.throws(() => releaseMetadataFromChangelog("## 1.2.3\n", "1.2.3"), /non-empty body/);

// Emulate the GitHub command boundary while exercising real file downloads and
// the production recovery algorithm. A failed upload persists preceding bytes.
function remote({ release = null, assets = {}, tagSha = sourceCommit, failUpload = false, failEdit = false, corruptDownload = false, readError = false, moveTagAfterUpload = false } = {}) {
  const state = { release, assets: { ...assets }, calls: [], failUpload, failEdit, corruptDownload, readError, tagSha };
  state.gh = (args) => {
    state.calls.push(args);
    const [category, action] = args;
    const option = flag => args[args.indexOf(flag) + 1];
    if (category === "api") return state.tagSha;
    assert.equal(category, "release");
    if (action === "view") {
      if (state.readError) throw new Error("GitHub unavailable");
      return state.release ? JSON.stringify({ ...state.release, assets: Object.keys(state.assets).map(name => ({ name })) }) : null;
    }
    if (action === "create") {
      assert.equal(state.release, null);
      assert.ok(args.includes("--verify-tag") && args.includes("--draft"));
      assert.equal(option("--target"), sourceCommit);
      state.release = { ...completed, isDraft: true, name: option("--title"), body: readFileSync(option("--notes-file"), "utf8") };
    } else if (action === "download") {
      for (const [name, contents] of Object.entries(state.assets)) writeFileSync(resolve(option("--dir"), name), state.corruptDownload ? "corrupt" : contents);
    } else if (action === "upload") {
      assert.equal(state.release.isDraft, true, "must never upload to a public release");
      assert.ok(!args.includes("--clobber"));
      const paths = args.slice(args.indexOf("--repo") + 2);
      for (const path of paths) {
        const name = basename(path);
        assert.ok(!(name in state.assets), "must never replace retained bytes");
        state.assets[name] = readFileSync(path);
        if (state.failUpload) throw new Error("upload interrupted after persisting an asset");
      }
      if (moveTagAfterUpload) state.tagSha = "2".repeat(40);
    } else if (action === "edit") {
      assert.equal(state.release.isDraft, true);
      assert.ok(args.includes("--draft=false"));
      assert.deepEqual(Object.keys(state.assets).sort(), [...files].sort());
      if (state.failEdit) throw new Error("publication interrupted");
      state.release.isDraft = false;
    } else throw new Error(`unexpected gh operation ${args.join(" ")}`);
    return "";
  };
  return state;
}
const publish = state => publishRelease({ directory: temporary, repository: "example/ytm", sourceCommit, metadata, files, gh: state.gh });
const mutations = state => state.calls.filter(([category, action]) => category === "release" && ["create", "upload", "edit"].includes(action));
try {
  for (const [name, contents] of Object.entries(bytes)) await writeFile(resolve(temporary, name), contents);
  const fresh = remote();
  await publish(fresh);
  assert.equal(fresh.release.isDraft, false);
  assert.deepEqual(mutations(fresh).map(call => call[1]), ["create", "upload", "edit"]);
  fresh.calls = [];
  await publish(fresh);
  assert.equal(mutations(fresh).length, 0, "public complete reruns must be read-only");

  const partial = remote({ failUpload: true });
  await assert.rejects(publish(partial), /upload interrupted/);
  assert.equal(partial.release.isDraft, true);
  assert.equal(Object.keys(partial.assets).length, 1);
  const retained = Object.keys(partial.assets)[0];
  partial.failUpload = false;
  partial.calls = [];
  await publish(partial);
  assert.ok(!mutations(partial).find(call => call[1] === "upload").some(arg => arg.endsWith(`/${retained}`)));
  assert.equal(partial.release.isDraft, false);

  const visibility = remote({ failEdit: true });
  await assert.rejects(publish(visibility), /publication interrupted/);
  assert.equal(visibility.release.isDraft, true);
  visibility.failEdit = false;
  visibility.calls = [];
  await publish(visibility);
  assert.deepEqual(mutations(visibility).map(call => call[1]), ["edit"]);

  for (const [options, diagnostic] of [
    [{ tagSha: "2".repeat(40) }, /verified source/],
    [{ readError: true }, /GitHub unavailable/],
    [{ release: { ...completed }, assets: { [files[0]]: bytes[files[0]] } }, /missing required assets/],
    [{ release: { ...completed, isDraft: true }, assets: { [files[0]]: Buffer.from("different") } }, /differs from the verified candidate/],
    [{ release: { ...completed, isDraft: true }, assets: { "unexpected.txt": Buffer.from("unexpected") } }, /unexpected assets/],
    [{ release: { ...completed, name: "edited" }, assets: bytes }, /name differs/],
    [{ release: { ...completed, body: "edited" }, assets: bytes }, /body differs/],
    [{ release: { ...completed, isPrerelease: true }, assets: bytes }, /must not be a prerelease/],
    [{ release: { ...completed }, assets: bytes, corruptDownload: true }, /differs from the verified candidate/],
  ]) {
    const state = remote(options);
    await assert.rejects(publish(state), diagnostic);
    assert.equal(mutations(state).length, 0, "unsafe recovery must fail before mutation");
  }
  const moved = remote({ moveTagAfterUpload: true });
  await assert.rejects(publish(moved), /verified source/);
  assert.equal(moved.release.isDraft, true, "a changed tag must block visibility");
  const corrupt = remote({ corruptDownload: true });
  await assert.rejects(publish(corrupt), /differs from the verified candidate/);
  assert.equal(corrupt.release.isDraft, true, "bad re-downloaded bytes must block visibility");
  const crlf = remote({ release: { ...completed, body: metadata.body.replaceAll("\n", "\r\n") }, assets: bytes });
  await publish(crlf);
  assert.equal(mutations(crlf).length, 0);
  assert.deepEqual(await readFile(resolve(temporary, files[0])), bytes[files[0]], "tests must preserve candidate bytes");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log("CLI publication, interrupted upload, visibility recovery, and immutable rerun tests passed");
