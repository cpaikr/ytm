const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;

export function expectedReleaseTag(version) {
  if (!STABLE_SEMVER.test(version || "")) {
    throw new Error(`Expected version must be stable SemVer, received ${JSON.stringify(version)}.`);
  }
  return `v${version}`;
}

export function canonicalReleaseUrl(serverUrl, repository, tag) {
  const normalizedServer = serverUrl?.replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+(?:\/.*)?$/.test(normalizedServer || "")) {
    throw new Error(`Invalid GitHub server URL ${JSON.stringify(serverUrl)}.`);
  }
  if (!/^[^/]+\/[^/]+$/.test(repository || "")) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(repository)}.`);
  }
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || "")) {
    throw new Error(`Invalid release tag ${JSON.stringify(tag)}.`);
  }
  return `${normalizedServer}/${repository}/releases/tag/${tag}`;
}

export function approvedReleasePullRequest(pulls, expectedVersion, sourceSha) {
  if (!Array.isArray(pulls)) throw new Error("GitHub pull requests must be an array.");
  assertSha(sourceSha, "release PR merge SHA");
  const expectedTitle = `chore(main): release ${expectedVersion}`;
  const expectedHead = "release-please--branches--main--components--ytm";
  const matches = pulls.filter((pull) =>
    pull?.merged_at &&
    pull?.merge_commit_sha === sourceSha &&
    pull?.base?.ref === "main" &&
    pull?.head?.ref === expectedHead &&
    pull?.title === expectedTitle &&
    pull?.labels?.some(({ name }) => name === "autorelease: pending" || name === "autorelease: tagged")
  );
  if (matches.length !== 1) {
    throw new Error(`Approved source ${sourceSha} must be the unique merged Release Please PR for ${expectedVersion}.`);
  }
  return matches[0];
}

export function classifyReleaseState({
  expectedVersion,
  workflowRef,
  workflowSha,
  mainSha,
  tagSha,
  releases,
  expectedReleaseName,
  expectedReleaseBody,
}) {
  const tag = expectedReleaseTag(expectedVersion);
  assertSha(workflowSha, "workflow SHA");
  assertSha(mainSha, "main SHA");
  if (tagSha !== null) assertSha(tagSha, "tag commit SHA");
  if (!Array.isArray(releases)) throw new Error("GitHub releases must be an array.");
  if (releases.length > 1) throw new Error(`More than one GitHub Release uses ${tag}.`);

  const release = releases[0] || null;
  if (tagSha === null) {
    if (release) throw new Error(`GitHub Release ${tag} exists without its immutable tag.`);
    if (workflowRef !== "refs/heads/main") {
      throw new Error(`A new ${tag} release must be dispatched from main.`);
    }
    if (workflowSha !== mainSha) {
      throw new Error("The dispatch checkout is not the current origin/main commit.");
    }
    return { mode: "create", tag, release: null };
  }

  assertTaggedDispatch({ tag, workflowRef, workflowSha, mainSha, tagSha });
  if (!release) return { mode: "create_draft", tag, release: null };
  if (release.tag_name !== tag) throw new Error(`GitHub Release tag ${release.tag_name} does not match ${tag}.`);
  if (release.prerelease === true) throw new Error(`GitHub Release ${tag} must not be a prerelease.`);
  if (release.name !== expectedReleaseName) throw new Error(`GitHub Release ${tag} name does not match the tagged changelog.`);
  if (release.body !== expectedReleaseBody) throw new Error(`GitHub Release ${tag} body does not match the tagged changelog.`);
  if (release.draft !== true && release.draft !== false) throw new Error(`GitHub Release ${tag} has an invalid visibility state.`);
  return { mode: release.draft ? "resume" : "project", tag, release };
}

function assertTaggedDispatch({ tag, workflowRef, workflowSha, mainSha, tagSha }) {
  if (workflowSha !== tagSha) throw new Error(`The workflow source ${workflowSha} does not match tagged source ${tagSha}.`);
  if (workflowRef !== "refs/heads/main" && workflowRef !== `refs/tags/${tag}`) {
    throw new Error(`Resume ${tag} from its exact tag, or from main only while main still points to that tag commit.`);
  }
  if (workflowRef === "refs/heads/main" && mainSha !== tagSha) {
    throw new Error(`main has advanced beyond ${tag}; resume by dispatching the workflow at refs/tags/${tag}.`);
  }
}

function assertSha(value, label) {
  if (!SHA.test(value || "")) throw new Error(`Invalid ${label} ${JSON.stringify(value)}.`);
}
