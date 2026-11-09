/**
 * CLI output.
 *
 * Two rules matter here:
 *   1. Machine output (`--json`) is stable and never coloured.
 *   2. Nothing printed by the CLI may contain a secret value.
 */

import { TsirError } from '@tsir/container';
import { colorDisabled, createPalette, glyphs } from '@tsir/tui';

/**
 * Colour is a property of the *terminal*, decided in one place.
 *
 * This used to be its own `paint('32', …)` table, which meant the CLI and every other Tsir command
 * answered "may I use colour?" differently: this one required a TTY and honoured `NO_COLOR`, and
 * `@tsir/tui` additionally honoured `TERM=dumb`. Two answers to one question is how a product ends
 * up with a coloured line in the middle of a plain report. The palette is now `@tsir/tui`'s; what
 * stays here is the CLI's own requirement that `--json` and pipes are never coloured.
 */
const palette = createPalette({
  color: process.stdout.isTTY === true && !colorDisabled(),
});

export const style = {
  bold: (text: string): string => palette.paint('bold', text),
  dim: (text: string): string => palette.paint('dim', text),
  green: (text: string): string => palette.paint('success', text),
  red: (text: string): string => palette.paint('danger', text),
  yellow: (text: string): string => palette.paint('warning', text),
  cyan: (text: string): string => palette.paint('brand', text),
};

/**
 * The glyph set, so `TSIR_TUI=ascii` reaches the CLI too.
 *
 * Exported because the commands print their own marks (`✓ created …`, `✗ DPL_…`) and every one of
 * them used to hard-code the character. A glyph that cannot be swapped for an ASCII fallback on a
 * terminal that mangles box drawing is a glyph that appears as `?` in somebody's log.
 */
export const symbols: ReturnType<typeof glyphs> = glyphs();

export const ok = (message: string): void => {
  process.stdout.write(`${style.green(symbols.check)} ${message}\n`);
};

export const info = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

export const warn = (message: string): void => {
  process.stderr.write(`${style.yellow(symbols.warn)} ${message}\n`);
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
      process.stderr.write(`${style.red(symbols.cross)} ${error.message}\n`);
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
      process.stderr.write(`${style.red(symbols.cross)} ${error.message}\n`);
      if (error.hint !== undefined) process.stderr.write(`  ${style.dim(`↳ ${error.hint}`)}\n`);
      if (error.code !== undefined) process.stderr.write(`  ${style.dim(`code: ${error.code}`)}\n`);
    }
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    process.stderr.write(`${jsonDocument({ ok: false, message })}\n`);
  } else {
    process.stderr.write(`${style.red(symbols.cross)} ${message}\n`);
  }
  return EXIT.failure;
}
