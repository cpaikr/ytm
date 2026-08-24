import { readFile } from "node:fs/promises";
import { normalizeReleaseBody, releaseMetadataFromChangelog } from "./release-metadata-policy.mjs";

const mode = required("RELEASE_MODE");
if (!new Set(["create", "create_draft"]).has(mode)) throw new Error(`Cannot create a draft from release mode ${JSON.stringify(mode)}.`);
const version = required("EXPECTED_VERSION");
const sourceSha = required("GITHUB_SHA");
const repository = required("GITHUB_REPOSITORY");
const apiUrl = required("GITHUB_API_URL").replace(/\/$/, "");
const token = required("RELEASE_GITHUB_TOKEN");
const metadata = releaseMetadataFromChangelog(await readFile("CHANGELOG.md", "utf8"), version);

if (mode === "create") {
  await api("POST", `/repos/${repository}/git/refs`, {
    ref: `refs/tags/${metadata.tag}`,
    sha: sourceSha,
  }, 201);
}

const tag = await api("GET", `/repos/${repository}/git/ref/tags/${encodeURIComponent(metadata.tag)}`, undefined, 200);
if (tag.object?.type !== "commit" || tag.object?.sha !== sourceSha) {
  throw new Error(`Immutable tag ${metadata.tag} does not point to approved source ${sourceSha}.`);
}
const release = await api("POST", `/repos/${repository}/releases`, {
  tag_name: metadata.tag,
  target_commitish: sourceSha,
  name: metadata.name,
  body: metadata.body,
  draft: true,
  prerelease: false,
  generate_release_notes: false,
}, 201);
if (release.tag_name !== metadata.tag || release.name !== metadata.name || normalizeReleaseBody(release.body) !== metadata.body || release.draft !== true || release.prerelease !== false) {
  throw new Error(`GitHub did not create the exact approved draft ${metadata.tag}.`);
}
console.log(`Created exact draft ${metadata.tag} at ${sourceSha}.`);

async function api(method, path, body, expectedStatus) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ytm-release-workflow",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`GitHub ${method} ${path} failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
