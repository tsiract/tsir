/**
 * `tsir bootstrap --set key=value` (`CFG-110`).
 *
 * `--set` edits the managed deploy block and nothing else. The block is the only text bootstrap
 * owns, so the keys are the block's keys:
 *
 *   deploy.topology=separate|single   the topology
 *   deploy.targets=bun,cloudflare     the targets (same as --target)
 *   modules+=@tsir/queue              appends to deploy.includeModules; repeatable
 *
 * `preset` is refused on purpose: presets are written in `tsir.js` as user text, and bootstrap
 * never edits user text. Every value is checked here, before any file is read or written, so an
 * invalid plan can never be applied.
 */

import { UsageError } from '../output.ts';

/** The keys `--set` accepts. Shown in every refusal that names a key. */
export const SET_KEYS: readonly string[] = ['deploy.topology', 'deploy.targets', 'modules+'];

/** npm-style package names, scoped or not. Rejects anything that could break out of a string. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export interface SetOverrides {
  readonly topology?: 'separate' | 'single';
  readonly targets?: readonly string[];
  readonly includeModules: readonly string[];
}

/**
 * Pulls every `--set` out of argv and returns the rest, so the ordinary flag parser never sees
 * them. The flag parser keeps only the last value of a repeated flag, which would drop keys.
 */
export function takeRepeated(
  argv: readonly string[],
  flag: string,
): { readonly values: string[]; readonly rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === flag) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} expects key=value`, `accepted keys: ${SET_KEYS.join(', ')}`);
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
      continue;
    }
    rest.push(arg);
  }
  return { values, rest };
}

/** Parses and checks every `--set`. Throws `UsageError` on the first bad value. */
export function parseSetOverrides(values: readonly string[]): SetOverrides {
  let topology: 'separate' | 'single' | undefined;
  let targets: string[] | undefined;
  const includeModules: string[] = [];

  for (const raw of values) {
    const equals = raw.indexOf('=');
    if (equals <= 0) {
      throw new UsageError(
        `--set expects key=value (got "${raw}")`,
        `accepted keys: ${SET_KEYS.join(', ')}`,
      );
    }
    const key = raw.slice(0, equals).trim();
    const value = raw.slice(equals + 1).trim();

    switch (key) {
      case 'deploy.topology': {
        if (value !== 'separate' && value !== 'single') {
          throw new UsageError(`deploy.topology must be "separate" or "single" (got "${value}")`);
        }
        if (topology !== undefined && topology !== value) {
          throw new UsageError(`deploy.topology is set twice, to "${topology}" and "${value}"`);
        }
        topology = value;
        break;
      }
      case 'deploy.targets': {
        const list = value
          .split(',')
          .map((target) => target.trim())
          .filter((target) => target !== '');
        if (targets !== undefined) {
          throw new UsageError('deploy.targets is set twice', 'list every target in one --set');
        }
        targets = list;
        break;
      }
      case 'modules+': {
        if (!PACKAGE_NAME.test(value)) {
          throw new UsageError(
            `modules+= expects a package name (got "${value}")`,
            'for example modules+=@tsir/queue',
          );
        }
        if (!includeModules.includes(value)) includeModules.push(value);
        break;
      }
      case 'preset':
        throw new UsageError(
          '--set preset is refused: presets are written in tsir.js, and bootstrap does not edit user text',
          'add the preset to presets: [...] in tsir.js',
        );
      default:
        throw new UsageError(`unknown --set key "${key}"`, `accepted keys: ${SET_KEYS.join(', ')}`);
    }
  }

  return {
    ...(topology === undefined ? {} : { topology }),
    ...(targets === undefined ? {} : { targets }),
    includeModules,
  };
}
