import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliArchiveName, loadCliReleasePolicy } from "./cli-release-policy.mjs";
import { releaseMetadataFromChangelog, normalizeReleaseBody } from "./release-metadata-policy.mjs";

function command(executable, args, allowMissing = false) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 120_000 });
  if (allowMissing && result.status !== 0 && /^release not found\s*$/.test(result.stderr ?? "")) return null;
  assert.equal(result.status, 0, `${executable} ${args.slice(0, 2).join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

// The injected command runner lets recovery tests exercise the actual publication
// sequence without granting them a token or mutating a remote release.
export async function publishRelease({ directory, repository, sourceCommit, metadata, files, gh = (args, missing) => command("gh", args, missing) }) {
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(sourceCommit ?? "", /^[a-f0-9]{40}$/);
  const { tag } = metadata;
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const candidate = resolve(directory);
  assert.deepEqual((await readdir(candidate)).sort(), [...files].sort(), "unexpected CLI candidate inventory");
  const verifyTag = () => assert.equal(
    gh(["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"]), sourceCommit,
    "remote release tag must still identify the verified source",
  );
  const readRelease = () => {
    const result = gh(["release", "view", tag, "--repo", repository, "--json", "isDraft,isPrerelease,assets,tagName,name,body"], true);
    if (result === null) return null;
    const release = JSON.parse(result);
    assert.equal(release.tagName, tag, "release tag changed");
    assert.equal(release.name, metadata.name, "release name differs from the tagged changelog");
    assert.equal(normalizeReleaseBody(release.body), metadata.body, "release body differs from the tagged changelog");
    assert.equal(release.isPrerelease, false, "stable CLI release must not be a prerelease");
    assert.equal(typeof release.isDraft, "boolean", "unknown release visibility");
    return release;
  };
  const verifyDownloads = async (release, complete) => {
    const names = release.assets.map(({ name }) => name).sort();
    assert.equal(new Set(names).size, names.length, "duplicate release asset names");
    assert.ok(names.every(name => files.includes(name)), "release contains unexpected assets");
    if (complete) assert.deepEqual(names, [...files].sort(), "release is missing required assets");
    if (!names.length) return;
    const download = await mkdtemp(resolve(tmpdir(), "ytm-release-download-"));
    try {
      gh(["release", "download", tag, "--repo", repository, "--dir", download]);
      assert.deepEqual((await readdir(download)).sort(), names, "downloaded inventory differs from the release");
      for (const name of names) {
        const [local, remote] = await Promise.all([readFile(resolve(candidate, name)), readFile(resolve(download, name))]);
        assert.ok(local.equals(remote), `remote ${name} differs from the verified candidate; existing assets were not changed`);
      }
    } finally {
      await rm(download, { recursive: true, force: true });
    }
  };

  verifyTag();
  let release = readRelease();
  if (!release) {
    const temporary = await mkdtemp(resolve(tmpdir(), "ytm-release-notes-"));
    try {
      const notes = resolve(temporary, "notes.md");
      await writeFile(notes, metadata.body);
      gh(["release", "create", tag, "--repo", repository, "--draft", "--verify-tag", "--target", sourceCommit, "--title", metadata.name, "--notes-file", notes]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    release = readRelease();
  }
  assert.ok(release, "created release could not be read back");
  await verifyDownloads(release, !release.isDraft);
  if (release.isDraft) {
    const existing = new Set(release.assets.map(({ name }) => name));
    const missing = files.filter(name => !existing.has(name));
    if (missing.length) gh(["release", "upload", tag, "--repo", repository, ...missing.map(name => resolve(candidate, name))]);
    release = readRelease();
    assert.ok(release, "release disappeared during upload");
    await verifyDownloads(release, true);
    verifyTag();
    if (release.isDraft) gh(["release", "edit", tag, "--repo", repository, "--draft=false"]);
  }
  verifyTag();
  release = readRelease();
  assert.equal(release?.isDraft, false, "release publication was not confirmed");
  await verifyDownloads(release, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, tag] = process.argv.slice(2);
  assert.ok(directory && tag, "Usage: publish-release.mjs <CLI-candidate-directory> <tag>");
  const sourceCommit = process.env.SOURCE_COMMIT;
  assert.equal(command("git", ["rev-parse", "HEAD"]), sourceCommit, "publisher checkout differs from verified source");
  assert.equal(command("git", ["rev-parse", `refs/tags/${tag}^{commit}`]), sourceCommit, "local tag differs from verified source");
  command("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  const version = (await readFile("VERSION", "utf8")).trim();
  const metadata = releaseMetadataFromChangelog(await readFile("CHANGELOG.md", "utf8"), version);
  assert.equal(tag, metadata.tag, "release tag must match VERSION");
  const { manifest } = await loadCliReleasePolicy(process.cwd());
  assert.equal(process.env.GITHUB_REPOSITORY, manifest.repository, "release repository must match installer identity");
  command(process.execPath, ["scripts/validate-cli-artifact-set.mjs", directory]);
  const files = [...manifest.targets.map(target => cliArchiveName(manifest, target, version)), manifest.installerAssets.shell, manifest.installerAssets.powershell, manifest.checksumFile];
  await publishRelease({ directory, repository: manifest.repository, sourceCommit, metadata, files });
  console.log(`Published and downloaded verified ${manifest.repository} ${tag}`);
}
