/**
 * The configuration schema as data (`CFG-116`): what `tsir config:dump --json` prints next to the
 * values. A machine reads it to know which keys exist, which are required, and which are secret.
 *
 * A secret field's default is never included, so the document is safe to publish.
 */

import type { ConfigSpec } from './define.ts';

export interface ConfigSchemaField {
  readonly key: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly overridable: boolean;
  readonly description: string | null;
  /** The declared default in its input form. Absent for a required field and for a secret one. */
  readonly default?: string | number | boolean | null;
}

export interface ConfigSchemaDocument {
  readonly fields: readonly ConfigSchemaField[];
}

/** The schema of an application's configuration, fields sorted by key. */
export function configSchemaDocument(spec: ConfigSpec): ConfigSchemaDocument {
  const fields = Object.keys(spec)
    .sort()
    .map((key): ConfigSchemaField => {
      const field = spec[key];
      const base = {
        key,
        required: field === undefined ? true : !field.hasDefault,
        secret: field?.secret === true,
        overridable: field?.overridable === true,
        description: field?.description ?? null,
      };
      const value: unknown = field?.defaultInput;
      const publishable =
        field?.hasDefault === true &&
        field.secret !== true &&
        (value === null || ['string', 'number', 'boolean'].includes(typeof value));
      return publishable ? { ...base, default: value as string | number | boolean | null } : base;
    });
  return { fields };
}
