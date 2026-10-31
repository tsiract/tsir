import { TsirError } from '@tsir/container';

/** Every code the configuration layer raises (`CFG-*`). `check-error-codes` enforces it. */
export type ConfigErrorCode =
  | 'CFG_INVALID'
  | 'CFG_INVALID_DEFAULT'
  | 'CFG_MANAGED_REGION_INVALID'
  | 'CFG_MISSING_KEY'
  | 'CFG_UNKNOWN_KEY'
  | 'CFG_CONFIG_VERSION_STALE'
  | 'CFG_MISSING_DEFAULT'
  | 'CFG_UNKNOWN_DEFAULT'
  | 'CFG_MODULE_NOT_INSTALLED'
  | 'CFG_AMBIGUOUS_CONNECTION'
  | 'CFG_PRESET_MODULE_MISSING'
  | 'CFG_SECRET_INLINED';

export interface ConfigIssue {
  /** Environment variable / config key, or a dotted path inside `tsir.js`. */
  readonly key: string;
  readonly message: string;
  /** Where the value came from: `env`, `default`, or `tsir.js:<region>`. */
  readonly source: string;
  readonly code: 'missing' | 'invalid' | 'unknown' | 'not-overridable' | 'secret-inlined';
}

export function configInvalid(issues: readonly ConfigIssue[]): TsirError {
  const sorted = [...issues].sort((a, b) => a.key.localeCompare(b.key));
  const lines = sorted
    .map((issue) => `${issue.key}: ${issue.message} (${issue.source})`)
    .join('\n');
  return new TsirError('CFG_INVALID', `Configuration is invalid:\n${lines}`, {
    kind: 'config',
    hint: 'fix every issue above and restart; Tsir never boots with a partial configuration',
    context: { issues: sorted.length },
  });
}

export function configError(
  code: string,
  message: string,
  hint?: string,
  context?: Readonly<Record<string, string | number | boolean>>,
): TsirError {
  return new TsirError(code, message, {
    kind: 'config',
    ...(hint === undefined ? {} : { hint }),
    ...(context === undefined ? {} : { context }),
  });
}

/** Formats a boot report. Kept separate so it can be snapshot-tested. */
export function formatConfigReport(issues: readonly ConfigIssue[], appName: string): string {
  const sorted = [...issues].sort((a, b) => a.key.localeCompare(b.key));
  const width = sorted.reduce((max, issue) => Math.max(max, issue.key.length), 0);
  const rows = sorted.map(
    (issue) => `  ${issue.key.padEnd(width)}  ${issue.message}   ${issue.source}`,
  );
  return [
    `✗ configuration invalid for "${appName}" (CFG_INVALID)`,
    ...rows,
    '  ↳ fix the above and restart; no partial boot is attempted.',
  ].join('\n');
}
