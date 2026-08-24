import { readFile } from "node:fs/promises";
import { normalizeReleaseBody, releaseMetadataFromChangelog } from "./release-metadata-policy.mjs";

const version = required("RELEASE_VERSION");
const expectedVisibility = required("EXPECTED_RELEASE_VISIBILITY");
if (!new Set(["draft", "public"]).has(expectedVisibility)) throw new Error(`Invalid expected Release visibility ${JSON.stringify(expectedVisibility)}.`);
const repository = required("GITHUB_REPOSITORY");
const releaseId = required("RELEASE_ID");
const apiUrl = required("GITHUB_API_URL").replace(/\/$/, "");
const token = process.env.RELEASE_GITHUB_TOKEN || required("GH_TOKEN");
const metadata = releaseMetadataFromChangelog(await readFile("CHANGELOG.md", "utf8"), version);
const response = await fetch(`${apiUrl}/repos/${repository}/releases/${releaseId}`, {
  signal: AbortSignal.timeout(30_000),
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "ytm-release-workflow",
  },
});
if (!response.ok) throw new Error(`GitHub Release metadata lookup failed with HTTP ${response.status}.`);
const release = await response.json();
const expectedDraft = expectedVisibility === "draft";
if (release.tag_name !== metadata.tag || release.name !== metadata.name || normalizeReleaseBody(release.body) !== metadata.body || release.draft !== expectedDraft || release.prerelease !== false) {
  throw new Error(`GitHub Release ${metadata.tag} does not match immutable ${expectedVisibility} changelog metadata.`);
}
console.log(`GitHub Release ${metadata.tag} matches immutable ${expectedVisibility} metadata.`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
