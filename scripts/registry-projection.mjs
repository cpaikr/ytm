import { appendFile, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, projectionState } from './product-artifact-policy.mjs';

const [registry, directoryArg, visibility] = process.argv.slice(2);
if (!['npm', 'pypi'].includes(registry) || !['draft', 'public'].includes(visibility)) {
  throw new Error('Usage: registry-projection.mjs npm|pypi <canonical-directory> draft|public');
}
const directory = resolve(directoryArg);
execFileSync(process.execPath, ['scripts/product-artifacts.mjs', 'validate', directory], { stdio: 'inherit' });
const version = (await readFile('VERSION', 'utf8')).trim();
if (registry === 'pypi' && (Number(version.split('.')[0]) === 0 && (Number(version.split('.')[1]) < 2 || (Number(version.split('.')[1]) === 2 && Number(version.split('.')[2]) === 0)))) {
  throw new Error('Rewritten PyPI publication requires an approved version greater than historical 0.2.0.');
}
const names = (await readdir(directory)).filter(n => n.endsWith(registry === 'npm' ? '.tgz' : '.whl')).sort();
const expected = await Promise.all(names.map(async name => ({ name, sha256: sha256(await readFile(join(directory, name))) })));
const observed = [];
async function request(url, absentAllowed = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (absentAllowed && response.status === 404) return null;
  if (!response.ok) throw new Error(`Cannot establish ${registry} state: HTTP ${response.status}`);
  return response;
}
if (registry === 'npm') {
  for (const name of names) {
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', join(directory, name), 'package/package.json'], { encoding: 'utf8' }));
    const response = await request(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}`, true);
    if (!response) continue;
    const data = await response.json();
    if (data.name !== pkg.name || data.version !== version || typeof data.dist?.tarball !== 'string') throw new Error('Malformed npm identity.');
    const url = new URL(data.dist.tarball);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Unexpected npm artifact origin.');
    observed.push({ name, sha256: sha256(Buffer.from(await (await request(url)).arrayBuffer())) });
  }
} else {
  const response = await request(`https://pypi.org/pypi/kisnet-ytm/${version}/json`, true);
  if (response) {
    const data = await response.json();
    if (data.info?.name !== 'kisnet-ytm' || data.info?.version !== version || !Array.isArray(data.urls) || data.urls.length === 0) {
      throw new Error('Malformed or empty existing PyPI version; absence not proven.');
    }
    for (const file of data.urls) {
      if (file.packagetype !== 'bdist_wheel' || file.yanked || !/^[0-9a-f]{64}$/.test(file.digests?.sha256 || '')) throw new Error('Unexpected PyPI artifact.');
      observed.push({ name: file.filename, sha256: file.digests.sha256 });
    }
  }
}
const state = projectionState(expected, observed, { publicRelease: visibility === 'public' });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `state=${state}\n`);
if (registry === 'pypi' && visibility === 'public' && state === 'absent') {
  // The trusted-publishing action receives only canonical wheel bytes.
  const output = resolve('dist/pypi');
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('PyPI upload directory must be empty.');
  for (const name of names) await copyFile(join(directory, name), join(output, name));
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${registry} projection: ${state}. Canonical release remains intact.\n`);
console.log(`${registry} projection: ${state}`);
