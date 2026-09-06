import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { productManifest, sha256, verifyManifest } from './product-artifact-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (process.env.RELEASE_SHA && process.env.RELEASE_SHA !== source) throw new Error('Checkout differs from release source.');
const [action, candidateArg, remoteArg] = process.argv.slice(2);
const directory = resolve(candidateArg || 'dist/product');
const python = process.env.PYO3_PYTHON || 'python';
const run = (script, ...args) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, stdio: 'inherit' });

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some((e) => !e.isFile())) throw new Error(`Non-file candidate entry in ${path}`);
  return new Map(await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (e) => [e.name, await readFile(join(path, e.name))])));
}

if (action === 'assemble') {
  run('validate-cli-artifact-set.mjs', 'dist/cli');
  run('validate-release-artifacts.mjs', 'dist/npm/native', 'dist/npm/root');
  execFileSync(python, [join(root, 'scripts/python-artifacts.py'), 'validate', 'dist/python'], { cwd: root, stdio: 'inherit' });
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error('Canonical output must be empty.');
  for (const part of ['dist/cli', 'dist/npm/native', 'dist/npm/root', 'dist/python']) {
    for (const [name] of await files(join(root, part))) {
      if ((await readdir(directory)).includes(name)) throw new Error(`Duplicate canonical name ${name}`);
      await copyFile(join(root, part, name), join(directory, name));
    }
  }
  const assets = [...await files(directory)].map(([name, data]) => ({ name, size: data.length, sha256: sha256(data) })).sort((a, b) => a.name < b.name ? -1 : 1);
  await writeFile(join(directory, productManifest), JSON.stringify({ schemaVersion: 1, version, sourceCommit: source, assets }, null, 2) + '\n');
} else if (action === 'validate' || action === 'plan') {
  const candidate = await files(directory);
  const metadata = JSON.parse(candidate.get(productManifest)?.toString() || 'null');
  candidate.delete(productManifest);
  verifyManifest(metadata, version, source, candidate);
  // The manifest cannot authorize its own asset list: derive that list from source.
  const cli = JSON.parse(await readFile(join(root, 'cli-targets.json'), 'utf8'));
  const { cliArchiveName } = await import('./cli-release-policy.mjs');
  const native = JSON.parse(await readFile(join(root, 'native-targets.json'), 'utf8'));
  const py = JSON.parse(await readFile(join(root, 'python-targets.json'), 'utf8'));
  const npmNames = [...native.targets.map(t => t.packageName), JSON.parse(await readFile(join(root, native.rootPackage, 'package.json'), 'utf8')).name];
  const expected = [
    ...cli.targets.map(t => cliArchiveName(cli, t, version)), cli.installerAssets.shell, cli.installerAssets.powershell, cli.checksumFile,
    ...npmNames.map(n => `${n.replace(/^@/, '').replace('/', '-')}-${version}.tgz`),
    ...py.targets.flatMap(t => [`kisnet_ytm-${version}-cp311-abi3-${t.platform}.whl`, `${t.key}.json`]),
  ].sort();
  if (JSON.stringify([...candidate.keys()].sort()) !== JSON.stringify(expected)) throw new Error('Canonical manifest omits or adds product assets.');
  if (action === 'plan') {
    if (!remoteArg) throw new Error('Downloaded release directory required.');
    candidate.set(productManifest, await readFile(join(directory, productManifest)));
    const remote = await files(resolve(remoteArg));
    for (const [name, data] of remote) {
      if (!candidate.get(name)?.equals(data)) throw new Error(`Existing canonical asset differs: ${name}`);
    }
    console.log(JSON.stringify({ missing: [...candidate.keys()].filter(n => !remote.has(n)).sort() }));
  } else console.log('Complete canonical product candidate verified.');
} else throw new Error('Usage: product-artifacts.mjs assemble|validate|plan <candidate> [downloaded]');
