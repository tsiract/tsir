/**
 * The bootstrap record: `.tsir/bootstrap.json` (`CFG-105`).
 *
 * `tsir bootstrap --yes` writes it, and `tsir start` reads it. The record says which config
 * format bootstrap wrote, what the deploy block looked like (a hash, so drift is visible without
 * storing the block), and which presets shaped the project. The file is runtime state under
 * `.tsir/`, which is gitignored with the rest of that folder.
 *
 * The record is deterministic: the same inputs give the same bytes, with no timestamp, so
 * running bootstrap twice leaves the file untouched (`CFG-104`).
 *
 * `tsir build` owns `.tsir/manifest.json` (the production manifest). This file is a different
 * record, so the two never share a name.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_FORMAT_VERSION, presetRecords, type PresetRecord } from '@tsir/config';

/** Where the record lives, relative to the project root. */
export const BOOTSTRAP_RECORD = join('.tsir', 'bootstrap.json');

export interface BootstrapRecord {
  readonly configVersion: number;
  readonly deploy: {
    readonly region: string;
    readonly sha256: string;
    readonly topology: string;
    readonly targets: readonly string[];
  };
  readonly presets: readonly PresetRecord[];
}

/** What reading the record found. A corrupt file is reported, not silently ignored. */
export type BootstrapRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly record: BootstrapRecord };

/**
 * Renders the record. `deployLines` is the deploy block as bootstrap renders it; only its hash
 * is stored, so a changed block is visible without the file holding the block itself.
 */
export function renderBootstrapRecord(input: {
  readonly region: string;
  readonly deployLines: readonly string[];
  readonly topology: string;
  readonly targets: readonly string[];
  readonly presets: readonly PresetRecord[];
}): string {
  const record: BootstrapRecord = {
    configVersion: PROJECT_FORMAT_VERSION,
    deploy: {
      region: input.region,
      sha256: createHash('sha256').update(input.deployLines.join('\n')).digest('hex'),
      topology: input.topology,
      targets: [...input.targets],
    },
    presets: input.presets.map((entry) => ({
      name: entry.name,
      version: entry.version,
      source: entry.source,
    })),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Reads the record under a project root. Missing and corrupt are different answers. */
export async function readBootstrapRecord(root: string): Promise<BootstrapRead> {
  let text: string;
  try {
    text = await readFile(join(root, BOOTSTRAP_RECORD), 'utf8');
  } catch (error: unknown) {
    if (isNotFound(error)) return { kind: 'missing' };
    throw error;
  }
  try {
    return { kind: 'ok', record: JSON.parse(text) as BootstrapRecord };
  } catch {
    return { kind: 'invalid' };
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The presets `tsir.js` applies right now. The file is imported fresh (it is data, so an edit
 * should be visible without a restart), and its `presets` list is read the way the loader reads it.
 */
export async function readPresetRecords(configPath: string): Promise<PresetRecord[]> {
  const module = (await import(`${pathToFileURL(configPath).href}?t=${String(Date.now())}`)) as {
    readonly default?: { readonly presets?: unknown };
  };
  const presets = module.default?.presets;
  return presetRecords(Array.isArray(presets) ? presets : []);
}

/**
 * What `tsir start` should say about the record before it boots (`CFG-105`). Pure, so each case
 * is a test. An empty list means nothing to report.
 */
export function bootstrapWarnings(
  read: BootstrapRead,
  currentPresets: readonly PresetRecord[],
): string[] {
  if (read.kind === 'missing') return [];
  if (read.kind === 'invalid') {
    return [`${BOOTSTRAP_RECORD} is not valid JSON; run tsir bootstrap --plan, then --yes`];
  }
  const warnings: string[] = [];
  const { record } = read;
  if (record.configVersion > PROJECT_FORMAT_VERSION) {
    warnings.push(
      `${BOOTSTRAP_RECORD} was written by a newer tsir (config format ${String(record.configVersion)}); this one reads format ${String(PROJECT_FORMAT_VERSION)}`,
    );
  }
  if (JSON.stringify(record.presets) !== JSON.stringify(currentPresets)) {
    warnings.push(
      'tsir.js presets changed since the last bootstrap; review them with tsir bootstrap --plan',
    );
  }
  return warnings;
}
