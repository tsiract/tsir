import { describe, expect, test } from 'bun:test';

import { UsageError } from './output.ts';
import { defineCommand, registerCommands } from './define-command.ts';

const run = async (): Promise<number> => 0;

function usageOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof UsageError ? error.message : 'NOT_USAGE';
  }
}

describe('defineCommand (CLI-019)', () => {
  test('a name, a summary, and a run function are enough', () => {
    expect(usageOf(() => defineCommand({ name: 'ping', summary: 'reply', run }))).toBeUndefined();
    expect(
      usageOf(() => defineCommand({ name: 'db:reset', summary: 'reset the db', run })),
    ).toBeUndefined();
  });

  test('a name that is not kebab or colon separated is refused', () => {
    expect(usageOf(() => defineCommand({ name: 'Ping', summary: 'x', run }))).toContain(
      'not a valid command name',
    );
    expect(usageOf(() => defineCommand({ name: 'a b', summary: 'x', run }))).toContain(
      'not a valid command name',
    );
  });

  test('an empty summary is refused, because help needs one line', () => {
    expect(usageOf(() => defineCommand({ name: 'ping', summary: '  ', run }))).toContain(
      'needs a summary',
    );
  });
});

describe('registerCommands (CLI-019)', () => {
  test('two commands with one name are refused, naming the second', () => {
    const first = { name: 'ping' };
    expect(usageOf(() => registerCommands([first, { name: 'pong' }]))).toBeUndefined();
    expect(usageOf(() => registerCommands([first, { name: 'ping' }]))).toContain(
      'command "ping" is defined twice',
    );
  });
});
