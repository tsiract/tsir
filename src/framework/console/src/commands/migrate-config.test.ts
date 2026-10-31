import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planConfigMigration } from './migrate-config.ts';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsir-migrate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('tsir bootstrap --migrate-config (CFG-122)', () => {
  test('a flat database block is planned as a primary connection', async () => {
    const body = `export default {
  app: { name: 'demo', entry: 'src/app.ts' },
  database: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } },
};\n`;
    writeFileSync(join(root, 'tsir.js'), body);
    const plan = await planConfigMigration(root);
    expect(plan.from).toBe(1);
    expect(plan.to).toBe(2);
    expect(plan.steps).toEqual(['flat-database-to-registry']);
    expect(plan.block).toBe(
      [
        'database: {',
        "  default: 'primary',",
        '  connections: {',
        '    primary: {',
        "      driver: 'postgres',",
        '      url: {',
        "        fromEnv: 'DATABASE_URL',",
        '      },',
        '    },',
        '  },',
        '},',
      ].join('\n'),
    );
  });

  test('the file is not written', async () => {
    const body = `export default { database: { driver: 'postgres' } };\n`;
    writeFileSync(join(root, 'tsir.js'), body);
    await planConfigMigration(root);
    expect(readFileSync(join(root, 'tsir.js'), 'utf8')).toBe(body);
  });

  test('a current file has nothing to migrate', async () => {
    writeFileSync(
      join(root, 'tsir.js'),
      `export default { database: { default: 'primary', connections: { primary: { driver: 'postgres' } } } };\n`,
    );
    const plan = await planConfigMigration(root);
    expect(plan.steps).toEqual([]);
    expect(plan.block).toBeUndefined();
  });
});
