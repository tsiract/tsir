/**
 * Application manifest.
 *
 * The manifest is *generated* (`tsir build`) and consumed at boot. It is the
 * mechanism that makes "no reflection in production" real: `bootstrap` reads
 * data, and the only way to get different data is to rebuild.
 *
 * Staleness is detected rather than tolerated — a manifest that disagrees with
 * the modules actually imported means someone skipped the build step.
 */

import type { ModuleDefinition } from './module.ts';

export const MANIFEST_FORMAT_VERSION = 1 as const;

export interface AppManifest {
  readonly formatVersion: typeof MANIFEST_FORMAT_VERSION;
  readonly appName: string;
  readonly modules: readonly string[];
  readonly providerCount: number;
  readonly generatedAt: string;
  /** Stable hash of the module list + provider tokens; changes when the graph changes. */
  readonly sourceHash: string;
}

export interface ManifestDrift {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly providerCount: number;
}

/** Deterministic, order-insensitive fingerprint of a module set. */
export function hashModules(modules: readonly ModuleDefinition[]): string {
  const parts = modules
    .map((module) => {
      const providers = [...(module.providers ?? [])]
        .map((provider) => `${provider.kind}:${provider.token.description}:${provider.lifetime}`)
        .sort();
      return `${module.name}[${providers.join(',')}]`;
    })
    .sort();
  const encoded = new TextEncoder().encode(parts.join('|'));
  // FNV-1a 32-bit: adequate for drift detection, not for security.
  let hash = 0x811c_9dc5;
  for (const byte of encoded) {
    hash ^= byte;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createManifest(
  appName: string,
  modules: readonly ModuleDefinition[],
  generatedAt: string,
): AppManifest {
  return Object.freeze({
    formatVersion: MANIFEST_FORMAT_VERSION,
    appName,
    modules: Object.freeze(modules.map((module) => module.name).sort()),
    providerCount: modules.reduce((total, module) => total + (module.providers?.length ?? 0), 0),
    generatedAt,
    sourceHash: hashModules(modules),
  });
}

export function diffManifest(
  manifest: AppManifest,
  modules: readonly ModuleDefinition[],
): ManifestDrift {
  const current = new Set(modules.map((module) => module.name));
  const declared = new Set(manifest.modules);
  return {
    added: [...current].filter((name) => !declared.has(name)).sort(),
    removed: [...declared].filter((name) => !current.has(name)).sort(),
    providerCount: modules.reduce((total, module) => total + (module.providers?.length ?? 0), 0),
  };
}

export function isManifestStale(
  manifest: AppManifest,
  modules: readonly ModuleDefinition[],
): boolean {
  const drift = diffManifest(manifest, modules);
  return (
    drift.added.length > 0 ||
    drift.removed.length > 0 ||
    hashModules(modules) !== manifest.sourceHash
  );
}
