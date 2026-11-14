import { describe, expect, test } from 'bun:test';

import { quickstartProblems } from './check-quickstart.ts';

/**
 * The quickstart gate (`DOCS-020`), tested on the defect it was written for.
 *
 * The real failure: `tsir new hello` followed by `cd hello`. Every command was valid, every link
 * resolved, and the sequence did not run — which is why this is checked as a sequence and not as a
 * list of names.
 */

describe('check-quickstart reads the order, not the words', () => {
  test('the defect it was written for is reported', () => {
    const problems = quickstartProblems('```sh\ntsir new hello\ncd hello\nbun install\n```\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.expected).toBe('apps/hello');
    expect(problems[0]?.found).toBe('hello');
  });

  test('the corrected sequence passes', () => {
    expect(
      quickstartProblems(
        '```sh\ntsir new hello\ncd apps/hello\nbun install --ignore-scripts\n```\n',
      ),
    ).toEqual([]);
  });

  test('./apps/hello and a trailing slash are the same directory', () => {
    expect(quickstartProblems('tsir new hello\ncd ./apps/hello/\n')).toEqual([]);
  });

  test('a document with no scaffold is not a quickstart and is skipped', () => {
    expect(quickstartProblems('```sh\ncd apps/hello\n```\n')).toEqual([]);
  });

  test('the frontpage form is read too: two adjacent code elements, not a block', () => {
    // The page most readers land on writes the pair as markup, so a line-oriented rule would have
    // passed while the page was wrong.
    expect(quickstartProblems('<code>tsir new hello</code><code>cd apps/hello</code>')).toEqual([]);
    expect(quickstartProblems('<code>tsir new hello</code><code>cd hello</code>')).toHaveLength(1);
  });

  test('a different project name is checked against its own directory', () => {
    const problems = quickstartProblems('tsir new billing-portal\ncd apps/hello\n');
    expect(problems[0]?.expected).toBe('apps/billing-portal');
  });
});
