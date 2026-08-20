import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const contractDirectory = new URL("../contracts/kisnet/", import.meta.url);
const destinations = [
  new URL("../packages/node/.kisnet-contract-sha256", import.meta.url),
  new URL("../packages/python/.kisnet-contract-sha256", import.meta.url)
];

const casesText = await readFile(new URL("cases.json", contractDirectory), "utf8");
const contract = JSON.parse(casesText);
const filenames = [...new Set(["openapi.yaml", "cases.json", ...Object.values(contract.fixtures || {})])].sort();
for (const filename of filenames) {
  if (
    typeof filename !== "string"
    || !filename
    || filename === "."
    || filename === ".."
    || /[/\\]/.test(filename)
  ) {
    throw new Error(`Shared contract fixture must be a direct filename: ${String(filename)}`);
  }
}

const hash = createHash("sha256");
for (const filename of filenames) {
  const content = filename === "cases.json"
    ? casesText
    : await readFile(new URL(filename, contractDirectory), "utf8");
  hash.update(`${filename}\0`);
  // Contract files are text; normalize checkout line endings before hashing.
  hash.update(content.replace(/\r\n/g, "\n"));
  hash.update("\0");
}
const expected = `${hash.digest("hex")}\n`;

if (process.argv.includes("--check")) {
  const stale = [];
  for (const destination of destinations) {
    const actual = (await readFile(destination, "utf8")).replace(/\r\n/g, "\n");
    if (actual !== expected) stale.push(destination.pathname);
  }
  if (stale.length > 0) {
    console.error(`Shared contract release hashes are stale: ${stale.join(", ")}`);
    console.error("Run `bun run contracts:sync` and commit both package hash files.");
    process.exit(1);
  }
  console.log("shared contract release hashes match");
} else {
  await Promise.all(destinations.map((destination) => writeFile(destination, expected)));
  console.log("shared contract release hashes updated");
}
