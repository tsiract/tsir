import { describe, expect, test } from 'bun:test';

import { countSource, regressions, type Baseline } from './dx-baseline.ts';

/**
 * The measurement behind `DX-000`. These tests exist because a baseline gate is only worth the
 * rules it counts with: a rule that matches nothing reports "0" forever and passes, and the ratchet
 * then protects a number nobody trusts.
 */

describe('dx-baseline counts the cost a call site pays', () => {
  test('an injected drizzle instance and its token are both counted', () => {
    const count = countSource(`
      import { drizzleToken } from '../../database.ts';
      export class UsersController {
        constructor(private readonly drizzle: typeof drizzle) {}
      }
      export const providers = [classProvider(t, C, [drizzleToken], {})];
    `);
    expect(count.drizzleParams).toBe(1);
    expect(count.tokenEntries).toBe(1);
    expect(count.files).toBe(1);
  });

  test('a query call site is counted, and the table it reads', () => {
    const count = countSource('const rows = await this.drizzle.select().from(users);');
    expect(count.querySites).toBe(1);
    expect(count.tables).toBe(1);
  });

  test('the same table twice is one table', () => {
    const count = countSource(`
      await this.drizzle.select().from(users);
      await this.drizzle.insert(users).values({});
    `);
    expect(count.querySites).toBe(2);
    expect(count.tables).toBe(1);
  });

  test('a type re-asserted with `as` is counted; a mail template cast is not', () => {
    expect(countSource('const db = raw as DrizzleDb;').casts).toBe(1);
    expect(countSource("'reset-password': tpl as unknown as MailTemplate<never>,").casts).toBe(0);
  });

  test('prose that names Drizzle is not a call site', () => {
    // `packages.ts` describes @tsir/database in a card. Before this rule it counted as a file with
    // one Drizzle touch and zero queries, which is a number that means nothing.
    const count = countSource("summary: 'Drizzle-backed database access with migrations',");
    expect(count.files).toBe(0);
    expect(count.querySites).toBe(0);
  });

  test('a file with a token but no query still counts: the DI list is the boilerplate', () => {
    const count = countSource(`
      import { drizzleToken } from '../../database.ts';
      export const providers = [classProvider(t, C, [drizzleToken], {})];
    `);
    expect(count.files).toBe(1);
    expect(count.tokenEntries).toBe(1);
    expect(count.querySites).toBe(0);
  });

  test('an import alone is not a provider list', () => {
    // Otherwise every file that imports the token reports one "entry" and the number stops meaning
    // what it says: an entry is a list that has to name it.
    expect(countSource("import { drizzleToken } from '../../database.ts';").tokenEntries).toBe(0);
  });
});

describe('the ratchet', () => {
  const baseline = (querySites: number, tokenEntries = 0): Baseline => ({
    applications: {
      a: { drizzleParams: 0, tokenEntries, casts: 0, querySites, tables: 0, files: 1 },
    },
    totals: { drizzleParams: 0, tokenEntries, casts: 0, querySites, tables: 0, files: 1 },
  });

  test('a rise is a regression, per application and in total', () => {
    const grown = regressions(baseline(1), baseline(2));
    expect(grown.map((entry) => entry.scope)).toContain('total');
    expect(grown.every((entry) => entry.field === 'querySites')).toBe(true);
  });

  test('a fall is not a regression', () => {
    expect(regressions(baseline(2), baseline(1))).toEqual([]);
  });

  test('an application that disappears is not a regression', () => {
    const removed: Baseline = { applications: {}, totals: baseline(0).totals };
    expect(regressions(baseline(0), removed)).toEqual([]);
  });
});
