/**
 * `moduleConfig` — extend an application config spec for a single module.
 *
 * Modules inherit the application's config spec and may override defaults or add
 * module-specific fields. Precedence at boot:
 *
 *   env[KEY]  >  module default  >  app default  >  root (tsir.js) default
 *
 * A module that does not call `moduleConfig` receives the application config as-is.
 * An application that declares no config gets an empty spec ({}) — both layers are
 * optional and default to an empty TypeScript object.
 */

import type { ConfigSpec } from './define.ts';

/**
 * Merge a module's config extension on top of the application spec.
 *
 * For keys present in both, the module's `FieldSpec` wins (its default
 * supersedes the app default; the environment still wins over both).
 * Keys only in the app or only in the module pass through unchanged.
 */
export function moduleConfig<Base extends ConfigSpec, Extension extends ConfigSpec>(
  base: Base,
  extension: Extension,
): Base & Extension {
  return Object.freeze({
    ...base,
    ...extension,
  }) as Base & Extension;
}
