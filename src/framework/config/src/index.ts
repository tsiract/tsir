/**
 * @tsir/config — typed, validated, redacted configuration.
 *
 * Public surface:
 *   defineConfig, env, Redacted, redact, loadConfig, fingerprint,
 *   managedRegions, hasManagedRegion, regionBody, applyManagedRegion, removeManagedRegion,
 *   renderRegion, fence, diffLines, formatDiff
 */

export { defineConfig, env, isFieldSpec } from './define.ts';
export type {
  BoolOptions,
  ConfigSpec,
  EnumOptions,
  FieldOptions,
  FieldSpec,
  InferConfig,
  IntOptions,
  StringOptions,
} from './define.ts';

export { loadConfig, fingerprint, requireConfigValue } from './load.ts';
export type { EnvRecord, LoadOptions, LoadedConfig } from './load.ts';

export { Redacted, isRedacted, redact } from './redacted.ts';
export type { RedactedOptions } from './redacted.ts';

export { configError, configInvalid, formatConfigReport } from './errors.ts';
export {
  PROJECT_FORMAT_VERSION,
  NAMED_REGISTRIES,
  PROJECT_TOP_LEVEL_KEYS,
  checkNamedRegistry,
  checkProjectFile,
  suggestKey,
  unknownProjectKeys,
} from './project-file.ts';
export type { NamedRegistry } from './project-file.ts';
export {
  BUILTIN_PRESET_VERSION,
  appendList,
  applyPresets,
  definePreset,
  mergeLayers,
  preset,
  presetModuleError,
  presetModules,
  presetRecords,
} from './presets.ts';
export type { AppendList, Preset, PresetRecord, ProjectLayer } from './presets.ts';
export { inlinedSecrets, inlinedSecretsInText, secretKind } from './secrets.ts';
export { configSchemaDocument } from './schema-doc.ts';
export type { ConfigSchemaDocument, ConfigSchemaField } from './schema-doc.ts';
export type { InlinedSecret, SecretKind } from './secrets.ts';
export {
  FLAT_CONNECTION_NAME,
  PROJECT_MIGRATIONS,
  detectProjectFormat,
  flatDatabaseToRegistry,
  migrateProject,
  renderLiteral,
} from './migrations.ts';
export type { MigrationResult, ProjectMigration, ProjectValue } from './migrations.ts';
export type { ConfigIssue } from './errors.ts';

export {
  applyManagedRegion,
  diffLines,
  fence,
  formatDiff,
  hasManagedRegion,
  managedRegions,
  regionBody,
  removeManagedRegion,
  renderRegion,
} from './managed.ts';
export type { LineDiff, ManagedRegion } from './managed.ts';
