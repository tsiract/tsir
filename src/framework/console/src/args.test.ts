import { describe, expect, test } from 'bun:test';

import { boolFlag, parseArgs, stringFlag } from './args.ts';
import { UsageError } from './output.ts';

describe('console · argument parsing', () => {
  const specs = {
    '--json': { type: 'boolean', description: 'machine-readable output' },
    '--port': { type: 'string', description: 'port', default: '3000' },
  } as const;

  test('flags declared with dashes are found without them', () => {
    // The bug this covers: spec keys are `--json`, lookups used to be `json`, so
    // every flag in every command was "unknown". It shipped unnoticed.
    const args = parseArgs(['--json'], specs);
    expect(boolFlag(args, '--json')).toBe(true);
    expect(boolFlag(args, 'json')).toBe(true); // both spellings work now
    expect(args.positionals).toEqual([]);
  });

  test('string flags consume the next argument or an inline value', () => {
    expect(stringFlag(parseArgs(['--port', '4000'], specs), '--port')).toBe('4000');
    expect(stringFlag(parseArgs(['--port=4001'], specs), '--port')).toBe('4001');
    expect(stringFlag(parseArgs([], specs), '--port')).toBe('3000'); // declared default
  });

  test('unknown flags and malformed values are usage errors, not silence', () => {
    expect(() => parseArgs(['--nope'], specs)).toThrow(UsageError);
    expect(() => parseArgs(['--nope'], specs)).toThrow(/unknown flag "--nope"/);
    expect(() => parseArgs(['--json=yes'], specs)).toThrow(/does not take a value/);
    expect(() => parseArgs(['--port'], specs)).toThrow(/expects a value/);
  });

  test('positionals are preserved in order', () => {
    expect(parseArgs(['users', '--json', 'extra'], specs).positionals).toEqual(['users', 'extra']);
  });
});
