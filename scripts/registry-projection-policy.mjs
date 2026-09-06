import { projectionState } from './product-artifact-policy.mjs';

export class TransientRegistryError extends Error {}

// Poll only after publication. Partial propagation may settle; conflicting bytes never can.
export async function waitForProjection(expected, readObserved, {
  timeoutMs = 120000, intervalMs = 5000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const observed = await readObserved(AbortSignal.timeout(Math.max(1, deadline - now())));
      if (!Array.isArray(observed)) throw new Error('Registry state is unknown.');
      const names = observed.map(asset => asset.name);
      if (new Set(names).size !== names.length || observed.some(asset =>
        !expected.some(wanted => wanted.name === asset.name && wanted.sha256 === asset.sha256))) {
        throw new Error('Conflicting registry assets; approve a new version. Never repair published bytes.');
      }
      if (observed.length === expected.length) return projectionState(expected, observed, { publicRelease: true });
    } catch (error) {
      if (!(error instanceof TransientRegistryError)) throw error;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error('Registry propagation deadline expired. Recheck state before recovery: wholly absent permits exact-tag retry; partial or conflicting requires a new version.');
}
