import { createHash } from 'node:crypto';

export const productManifest = 'release-assets.json';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function verifyManifest(manifest, version, source, files) {
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.sourceCommit !== source) {
    throw new Error('Canonical candidate version/source identity mismatch.');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== files.size) throw new Error('Incomplete canonical asset set.');
  const names = manifest.assets.map((a) => a.name);
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify([...files.keys()].sort())) {
    throw new Error('Canonical asset names are missing, duplicate, unexpected, or unsorted.');
  }
  for (const asset of manifest.assets) {
    const data = files.get(asset.name);
    if (asset.size !== data.length || asset.sha256 !== sha256(data)) throw new Error(`Canonical asset checksum mismatch: ${asset.name}`);
  }
}

export function projectionState(expected, observed, { publicRelease }) {
  if (!Array.isArray(observed)) throw new Error('Registry state is unknown.');
  if (observed.length === 0) return 'absent';
  const wanted = [...expected].sort((a, b) => a.name.localeCompare(b.name));
  const actual = [...observed].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error('Registry version is partial or conflicting; approve a new version. Never repair published bytes.');
  }
  if (!publicRelease) throw new Error('Registry version exists before canonical visibility; approve a new version.');
  return 'complete';
}
