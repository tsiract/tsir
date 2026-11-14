import { describe, expect, test } from 'bun:test';

import { contractProblems, currentContracts, removedNames } from './check-contracts.ts';

/**
 * The contracts a user types (`DOCS-011`), tested on fixtures.
 *
 * Each case is a rename a person would feel: a `tsir.js` key that stops validating, a command that
 * stops existing, an error code a caller branches on that disappears. The snapshot is a fixture
 * rather than the repository so the answer is known — a test that only asserted "the real snapshot
 * parses" would pass with every one of these rules inverted.
 */

const base = { config: ['app', 'database'], commands: ['dev', 'migrate'], errors: ['CFG_INVALID'] };

describe('check-contracts names what disappeared', () => {
  test('a removal is found even though the current code does not list the name', () => {
    // The trap: iterating the live registry to diff it cannot see a name the branch already
    // deleted, so the union of both sides is the only list that contains it.
    expect(removedNames(base, { ...base, commands: ['dev'] })).toEqual([
      { contract: 'commands', name: 'migrate' },
    ]);
  });

  test('an addition is not a removal', () => {
    expect(removedNames(base, { ...base, commands: [...base.commands, 'scan'] })).toEqual([]);
  });
});

describe('check-contracts requires a document for a rename', () => {
  test('a removed command with no doc change fails, naming the command', () => {
    const problems = contractProblems(base, { ...base, commands: ['dev'] }, ['apps/x.ts']);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('CLI command migrate');
  });

  test('the file that performs the rename is not the document that explains it', () => {
    const problems = contractProblems(base, { ...base, commands: ['dev'] }, [
      'src/framework/console/src/index.ts',
    ]);
    expect(problems).toHaveLength(1);
  });

  test('a doc change in the same branch satisfies it', () => {
    expect(
      contractProblems(base, { ...base, commands: ['dev'] }, ['src/docs/guides/make.md']),
    ).toEqual([]);
  });

  test('a removed tsir.js key is named as a key', () => {
    const problems = contractProblems(base, { ...base, config: ['app'] }, ['src/docs/index.md']);
    expect(problems).toEqual([]);
    const bare = contractProblems(base, { ...base, config: ['app'] }, ['apps/x.ts']);
    expect(bare[0]?.message).toContain('`tsir.js` key database');
  });

  test('an error code cannot be retired by editing a page', () => {
    const problems = contractProblems(base, { ...base, errors: [] }, ['src/docs/errors.md']);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('append-only');
  });
});

describe('check-contracts reads the repository it ships in', () => {
  test('the snapshot covers the three contracts with names in each', () => {
    const current = currentContracts();
    expect(Object.keys(current).sort()).toEqual(['commands', 'config', 'errors']);
    for (const name of ['commands', 'config', 'errors']) {
      expect(current[name]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
