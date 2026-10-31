/**
 * Argument parsing.
 *
 * Deliberately tiny: a command declares which flags it accepts, and unknown
 * flags are a usage error rather than being silently ignored. That is the
 * difference between a typo (`--prot 3001`) failing fast and a confusing run.
 */

import { UsageError } from './output.ts';

export interface FlagSpec {
  readonly type: 'string' | 'boolean';
  readonly description: string;
  readonly default?: string | boolean;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Spec keys are written the way they are typed (`'--json'`). The parser works on
 * the bare name, so normalize once here — otherwise every command has to agree
 * with itself about dashes, and one that does not silently accepts no flags at
 * all. (`tsir dev --json` was broken exactly that way.)
 */
function normalize(specs: FlagSpecs): Map<string, FlagSpec> {
  const normalized = new Map<string, FlagSpec>();
  for (const [key, spec] of Object.entries(specs)) {
    normalized.set(key.replace(/^--/, ''), spec);
  }
  return normalized;
}

export function parseArgs(argv: readonly string[], specs: FlagSpecs = {}): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const declared = normalize(specs);

  for (const [name, spec] of declared) {
    if (spec.default !== undefined) flags[name] = spec.default;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);
    const inline = equalsIndex === -1 ? undefined : withoutPrefix.slice(equalsIndex + 1);

    const spec = declared.get(name);
    if (spec === undefined) {
      throw new UsageError(
        `unknown flag "--${name}"`,
        `accepted flags: ${[...declared.keys()].map((key) => `--${key}`).join(', ') || '(none)'}`,
      );
    }

    if (spec.type === 'boolean') {
      if (inline !== undefined) {
        throw new UsageError(`--${name} does not take a value`);
      }
      flags[name] = true;
      continue;
    }

    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new UsageError(`--${name} expects a value`);
    }
    if (inline === undefined) index += 1;
    flags[name] = value;
  }

  return { positionals, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name.replace(/^--/, '')];
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name.replace(/^--/, '')] === true;
}

export function requireStringFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}
