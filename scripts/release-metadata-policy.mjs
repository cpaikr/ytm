export function expectedReleaseTag(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || "")) {
    throw new Error("Release version must be stable SemVer.");
  }
  return `v${version}`;
}

export function releaseMetadataFromChangelog(changelog, version) {
  const tag = expectedReleaseTag(version);
  const normalized = normalizeReleaseBody(changelog);
  const heading = /^##? (?:\[)?(\d+\.\d+\.\d+)(?:\])?(?:\([^\n]+\))?(?: \([^\n]+\))?[ \t]*$/gm;
  const first = heading.exec(normalized);
  if (!first || first[1] !== version) {
    throw new Error(`The first changelog release must be ${version}.`);
  }
  const bodyStart = first.index + first[0].length;
  const next = heading.exec(normalized);
  const body = normalized.slice(bodyStart, next?.index ?? normalized.length).trim();
  if (!body) throw new Error(`Changelog release ${version} must have a non-empty body.`);
  return { tag, name: tag, body: `${body}\n` };
}

export function normalizeReleaseBody(body) {
  return typeof body === "string" ? body.replace(/\r\n/g, "\n") : body;
}
