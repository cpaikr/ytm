import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const renderedUseCounts = (html) => {
  const counts = new Map();
  for (const section of html.matchAll(/<h3 id="([^"]+)">[\s\S]*?(?=<h3 id=|<\/main>)/g)) {
    counts.set(section[1], [...section[0].matchAll(/<li><a href="[^"]+">[^<]+<\/a><\/li>/g)].length);
  }
  return counts;
};
const reconcileOverviewCounts = (html) => {
  const counts = renderedUseCounts(html);
  return html.replace(/(<li><a href="#([^"]+)">[^<]+<\/a> \()\d+(\)<\/li>)/g, (entry, prefix, id, suffix) => {
    if (!counts.has(id)) throw new Error(`Third-party license overview has no rendered section for ${id}.`);
    return `${prefix}${counts.get(id)}${suffix}`;
  });
};
const assertOverviewCounts = (html) => {
  const counts = renderedUseCounts(html);
  for (const entry of html.matchAll(/<li><a href="#([^"]+)">[^<]+<\/a> \((\d+)\)<\/li>/g)) {
    const rendered = counts.get(entry[1]);
    if (rendered !== Number(entry[2])) {
      throw new Error(`Third-party license overview count for ${entry[1]} is ${entry[2]}, but ${rendered ?? 0} uses are rendered.`);
    }
  }
};
const version = spawnSync("cargo", ["about", "--version"], { encoding: "utf8" });
if (version.status !== 0) {
  throw new Error(`cargo-about 0.9.2 is required: ${version.stderr.trim()}`);
}
if (version.stdout.trim() !== "cargo-about 0.9.2") {
  throw new Error(`Expected cargo-about 0.9.2, received ${version.stdout.trim()}.`);
}

const generated = spawnSync(
  "cargo",
  ["about", "generate", "about.hbs", "--locked", "--fail"],
  { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);
if (generated.status !== 0) {
  throw new Error(`Could not generate third-party licenses:\n${generated.stderr.trim()}`);
}

const noticePath = resolve(repositoryRoot, "THIRD_PARTY_LICENSES.html");
const canonicalGenerated = reconcileOverviewCounts(generated.stdout.replaceAll("\r\n", "\n"));
if (!canonicalGenerated.endsWith("\n")) {
  throw new Error("cargo-about generated an incomplete third-party license notice.");
}
assertOverviewCounts(canonicalGenerated);
const metadata = spawnSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (metadata.status !== 0) {
  throw new Error(`Could not inspect workspace packages:\n${metadata.stderr.trim()}`);
}
for (const packageMetadata of JSON.parse(metadata.stdout).packages) {
  const firstPartyReceipt = `>${packageMetadata.name} ${packageMetadata.version}<`;
  if (canonicalGenerated.includes(firstPartyReceipt)) {
    throw new Error(`Third-party license notice must exclude first-party workspace package ${packageMetadata.name}.`);
  }
}
const notice = canonicalGenerated.slice(0, -1);
if (process.argv.includes("--write")) {
  await writeFile(noticePath, notice, "utf8");
  console.log("generated THIRD_PARTY_LICENSES.html");
} else {
  const expected = await readFile(noticePath, "utf8");
  if (notice !== expected.replaceAll("\r\n", "\n")) {
    throw new Error("THIRD_PARTY_LICENSES.html is stale; run bun run licenses:generate.");
  }
  console.log("third-party license notices are current");
}
