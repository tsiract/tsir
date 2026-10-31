/**
 * CLI output.
 *
 * Two rules matter here:
 *   1. Machine output (`--json`) is stable and never coloured.
 *   2. Nothing printed by the CLI may contain a secret value.
 */

import { TsirError } from '@tsir/container';

const color = (): boolean => process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

function paint(code: string, text: string): string {
  return color() ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const style = {
  bold: (text: string): string => paint('1', text),
  dim: (text: string): string => paint('2', text),
  green: (text: string): string => paint('32', text),
  red: (text: string): string => paint('31', text),
  yellow: (text: string): string => paint('33', text),
  cyan: (text: string): string => paint('36', text),
};

export const ok = (message: string): void => {
  process.stdout.write(`${style.green('✓')} ${message}\n`);
};

export const info = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

export const warn = (message: string): void => {
  process.stderr.write(`${style.yellow('!')} ${message}\n`);
};

/** Exit codes are part of the CLI contract. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  environment: 3,
} as const;

/**
 * CLI-002: the version of every `--json` document. Bump it on any breaking change to a shape;
 * adding a field is not breaking. Scripts can branch on it.
 */
export const JSON_SCHEMA_VERSION = 1;

/** Serialises a `--json` document with `schemaVersion` first, so every document is versioned. */
export function jsonDocument(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...value }, null, 2);
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;
  /** A stable code (for example `CFG_INVALID`) when the failure has one. */
  readonly code: string | undefined;

  constructor(message: string, exitCode: number = EXIT.failure, hint?: string, code?: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
    this.code = code;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.usage, hint);
    this.name = 'UsageError';
  }
}

export function fail(error: unknown, json: boolean): number {
  if (error instanceof TsirError) {
    if (json) {
      process.stderr.write(`${jsonDocument({ ok: false, ...error.toLogObject() })}\n`);
    } else {
      process.stderr.write(`${style.red('✗')} ${error.message}\n`);
      if (error.hint !== undefined) process.stderr.write(`  ${style.dim(`↳ ${error.hint}`)}\n`);
      process.stderr.write(`  ${style.dim(`code: ${error.code}`)}\n`);
    }
    return error.kind === 'config' ? EXIT.environment : EXIT.failure;
  }

  if (error instanceof CliError) {
    if (json) {
      process.stderr.write(
        `${jsonDocument({ ok: false, message: error.message, ...(error.code === undefined ? {} : { code: error.code }) })}\n`,
      );
    } else {
      process.stderr.write(`${style.red('✗')} ${error.message}\n`);
      if (error.hint !== undefined) process.stderr.write(`  ${style.dim(`↳ ${error.hint}`)}\n`);
      if (error.code !== undefined) process.stderr.write(`  ${style.dim(`code: ${error.code}`)}\n`);
    }
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    process.stderr.write(`${jsonDocument({ ok: false, message })}\n`);
  } else {
    process.stderr.write(`${style.red('✗')} ${message}\n`);
  }
  return EXIT.failure;
}
