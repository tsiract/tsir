import { describe, expect, test } from 'bun:test';

import {
  detectProjectFormat,
  migrateProject,
  renderLiteral,
  type ProjectValue,
} from './migrations.ts';
import { checkProjectFile } from './project-file.ts';

const FLAT: ProjectValue = {
  app: { name: 'demo', entry: 'src/app.ts' },
  database: {
    driver: 'postgres',
    url: { fromEnv: 'DATABASE_URL' },
    journal: false,
  },
};

describe('format detection', () => {
  test('a flat database block is format 1', () => {
    expect(detectProjectFormat(FLAT)).toBe(1);
  });

  test('a registry is the current format', () => {
    expect(
      detectProjectFormat({
        database: { default: 'primary', connections: { primary: { driver: 'postgres' } } },
      }),
    ).toBe(2);
  });
});

describe('flat → registry (CFG-122)', () => {
  test('the flat block becomes a primary connection with the same values', () => {
    const result = migrateProject(FLAT);
    expect(result.from).toBe(1);
    expect(result.to).toBe(2);
    expect(result.steps).toEqual(['flat-database-to-registry']);
    expect(result.value).toEqual({
      app: { name: 'demo', entry: 'src/app.ts' },
      database: {
        default: 'primary',
        connections: {
          primary: {
            driver: 'postgres',
            url: { fromEnv: 'DATABASE_URL' },
            journal: false,
          },
        },
      },
    });
  });

  test('the migrated file passes the project validation', () => {
    expect(() => checkProjectFile(migrateProject(FLAT).value)).not.toThrow();
  });

  test('a current file is returned unchanged with no steps', () => {
    const current: ProjectValue = {
      database: { default: 'primary', connections: { primary: { driver: 'postgres' } } },
    };
    const result = migrateProject(current);
    expect(result.steps).toEqual([]);
    expect(result.value).toBe(current);
  });

  test('the migrated block renders as the exact literal the user pastes', () => {
    const { value } = migrateProject(FLAT);
    expect(renderLiteral((value as { database: unknown }).database)).toBe(
      [
        '{',
        "  default: 'primary',",
        '  connections: {',
        '    primary: {',
        "      driver: 'postgres',",
        '      url: {',
        "        fromEnv: 'DATABASE_URL',",
        '      },',
        '      journal: false,',
        '    },',
        '  },',
        '}',
      ].join('\n'),
    );
  });
});

describe('renderLiteral', () => {
  test('quotes keys that are not identifiers and escapes quotes', () => {
    expect(renderLiteral({ 'read-replica': "it's" })).toBe("{\n  'read-replica': 'it\\'s',\n}");
  });
});
