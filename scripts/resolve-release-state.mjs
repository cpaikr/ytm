import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { approvedReleasePullRequest, canonicalReleaseUrl, classifyReleaseState, expectedReleaseTag } from "./release-state-policy.mjs";
import { releaseMetadataFromChangelog } from "./release-metadata-policy.mjs";

const phase = process.argv[2];
if (!new Set(["inspect", "resolve"]).has(phase)) {
  throw new Error("Usage: node scripts/resolve-release-state.mjs <inspect|resolve>");
}

const expectedVersion = required("EXPECTED_VERSION");
const expectedTag = expectedReleaseTag(expectedVersion);
const workflowRef = required("GITHUB_REF");
const workflowSha = required("GITHUB_SHA");
const repository = required("GITHUB_REPOSITORY");
const apiUrl = required("GITHUB_API_URL").replace(/\/$/, "");
const serverUrl = required("GITHUB_SERVER_URL");
const token = required("RELEASE_GITHUB_TOKEN");
const outputPath = required("GITHUB_OUTPUT");

const manifest = JSON.parse(await readFile("cli-targets.json", "utf8"));
if (manifest.repository !== repository) {
  throw new Error(`Workflow repository ${repository} does not match release policy ${manifest.repository}.`);
}
const sourceVersion = (await readFile("VERSION", "utf8")).trim();
if (sourceVersion !== expectedVersion) {
  throw new Error(`Submitted version ${expectedVersion} does not match VERSION ${sourceVersion}.`);
}
const checkoutSha = git(["rev-parse", "HEAD"]);
if (checkoutSha !== workflowSha) {
  throw new Error(`Checked-out source ${checkoutSha} does not match workflow source ${workflowSha}.`);
}

git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], { output: true });
const mainSha = git(["rev-parse", "refs/remotes/origin/main"]);
const tagSha = remoteTagCommit(expectedTag);
const releases = (await listReleases()).filter((release) => release.tag_name === expectedTag);
approvedReleasePullRequest(await listPullRequests(), expectedVersion, workflowSha);
const metadata = releaseMetadataFromChangelog(await readFile("CHANGELOG.md", "utf8"), expectedVersion);
const state = classifyReleaseState({
  expectedVersion,
  workflowRef,
  workflowSha,
  mainSha,
  tagSha,
  releases,
  expectedReleaseName: metadata.name,
  expectedReleaseBody: metadata.body,
});

if (tagSha !== null) {
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", tagSha, "refs/remotes/origin/main"], { encoding: "utf8" });
  if (ancestry.status !== 0) throw new Error(`Tag ${expectedTag} does not point to a commit on main.`);
}

if (phase === "inspect") {
  await writeOutputs({ mode: state.mode, expected_version: expectedVersion, expected_tag: expectedTag });
  console.log(`${expectedTag} release state: ${state.mode}`);
  process.exit(0);
}

const requestedMode = required("RELEASE_MODE");
if (new Set(["create", "create_draft"]).has(requestedMode)) {
  if (state.mode !== "resume") throw new Error(`Exact draft creation did not produce ${expectedTag}.`);
} else if (requestedMode === "resume") {
  if (state.mode !== "resume") throw new Error(`Draft ${expectedTag} changed while the workflow was resolving it.`);
} else if (requestedMode === "project") {
  if (state.mode !== "project") throw new Error(`Public Release ${expectedTag} changed while the workflow was resolving it.`);
} else {
  throw new Error(`Invalid release mode ${JSON.stringify(requestedMode)}.`);
}

await writeOutputs({
  version: expectedVersion,
  tag: expectedTag,
  source_sha: tagSha,
  release_id: String(state.release.id),
  release_url: canonicalReleaseUrl(serverUrl, repository, expectedTag),
  publication_mode: state.mode,
});
console.log(`Resolved ${state.mode === "project" ? "public" : "draft"} ${expectedTag} at ${tagSha}.`);

function remoteTagCommit(tag) {
  const probe = spawnSync("git", ["ls-remote", "--exit-code", "--refs", "origin", `refs/tags/${tag}`], { encoding: "utf8" });
  if (probe.status === 2) return null;
  if (probe.status !== 0) throw new Error(`Could not determine remote tag ${tag}: ${probe.stderr.trim()}`);
  git(["fetch", "--no-tags", "origin", `refs/tags/${tag}`], { output: true });
  return git(["rev-parse", "FETCH_HEAD^{commit}"]);
}

async function listReleases() {
  return paginatedJson(`${apiUrl}/repos/${repository}/releases?per_page=100`, "GitHub release lookup");
}

async function listPullRequests() {
  return paginatedJson(`${apiUrl}/repos/${repository}/commits/${workflowSha}/pulls?per_page=100`, "GitHub commit pull request lookup");
}

async function paginatedJson(initialUrl, label) {
  const values = [];
  let url = initialUrl;
  while (url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: githubHeaders(),
    });
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`${label} returned a non-array response.`);
    values.push(...page);
    url = nextLink(response.headers.get("link"));
  }
  return values;
}

function githubHeaders() {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "ytm-release-workflow",
  };
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

function git(args, { output = false } = {}) {
  const value = execFileSync("git", args, { encoding: "utf8", stdio: output ? "inherit" : ["ignore", "pipe", "pipe"] });
  return output ? "" : value.trim();
}

async function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join("\n");
  await appendFile(outputPath, `${lines}\n`, "utf8");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
