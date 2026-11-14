import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptySectionsIn, countExamples } from './doc-inventory.ts';
import { buildReport, render, tasksIn } from './task-status.ts';

/**
 * The ledger tools, tested on fixtures rather than on the repository.
 *
 * Both exist to catch documents that lie about their own state, so a test that only asserted
 * "the real plan directory parses" would pass while the parser got every column wrong. These
 * build a table where the answer is known, and assert the answer.
 */

const table = (...rows: string[]): string => rows.join('\n');

describe('task-status parses the notation the ledger actually uses', () => {
  test('every state word becomes a state, wherever the status column sits', () => {
    const source = table(
      '| ID | Title | Status | Depends | Acceptance |',
      '| --- | --- | --- | --- | --- |',
      '| `DB-001` | done thing | `[x]` | — | a test exists |',
      '| `DB-002` | half thing | `[~]` | DB-001 | a branch exists |',
      '| `DB-003` | not started | `[ ]` | — | a test will exist |',
      '| `DB-004` | waiting | `[!]` | DB-002 | blocked on the decision |',
    );
    const tasks = tasksIn('fixture.md', source);
    expect(tasks.map((task) => [task.id, task.state])).toEqual([
      ['DB-001', 'done'],
      ['DB-002', 'partial'],
      ['DB-003', 'open'],
      ['DB-004', 'blocked'],
    ]);
  });

  test('a file that puts the status in a different column still parses', () => {
    // The ledgers are not uniform: `03-http.md` has Status in column three, `07-deploy-cloud-checks`
    // has a `#` first. Finding the cell beats assuming the index.
    const source = table(
      '| # | Task | What it proves | Status |',
      '| --- | --- | --- | --- |',
      '| 1 | `DPL-008` | the adapter survives workerd | `[x]` |',
    );
    const tasks = tasksIn('fixture.md', source);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('DPL-008');
    expect(tasks[0]?.state).toBe('done');
  });

  test('a status with no id is reported, not silently dropped', () => {
    // The parity ledger's 245 feature rows are exactly this: a status, no id. Dropping them made
    // the ledger report 405 tasks when it has 650.
    const source = table(
      '| Feature | Laravel feature | Implementation | Evidence | Status |',
      '| --- | --- | --- | --- | --- |',
      '| Password hashing | bcrypt | `password.ts` | `password.test.ts` | `[x]` |',
    );
    const unidentified: { file: string; line: number; state: string; text: string }[] = [];
    const tasks = tasksIn('fixture.md', source, unidentified as never);
    expect(tasks).toHaveLength(0);
    expect(unidentified).toHaveLength(1);
    expect(unidentified[0]?.state).toBe('done');
  });

  test('the legacy ✅ is read as done', () => {
    const source = table(
      '| ID | Title | Status | Acceptance |',
      '| --- | --- | --- | --- |',
      '| `FND-001` | old row | ✅ | it shipped |',
    );
    expect(tasksIn('fixture.md', source)[0]?.state).toBe('done');
  });

  test('an open task with no acceptance text is a problem', () => {
    const source = table(
      '| ID | Title | Status | Depends | Acceptance |',
      '| --- | --- | --- | --- | --- |',
      '| `DB-009` | something | `[ ]` | — |  |',
    );
    const report = buildReportFrom('| ID | Title | Status | Depends | Acceptance |');
    expect(report.problems.some((problem) => problem.includes('DB-009'))).toBe(true);
    expect(source).toContain('DB-009');
  });
});

/** `buildReport` reads a directory; this writes one fixture file into it and reports on that. */
function buildReportFrom(header: string): ReturnType<typeof buildReport> {
  const dir = mkdtempSync(join(tmpdir(), 'tsir-tasks-'));
  try {
    writeFileSync(
      join(dir, 'fixture.md'),
      table(
        header,
        '| --- | --- | --- | --- | --- |',
        '| `DB-009` | something | `[ ]` | — |  |',
        '',
      ),
    );
    return buildReport(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the status page is generated, not written', () => {
  test('totals and the open list agree with the rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-tasks-'));
    try {
      writeFileSync(
        join(dir, 'a.md'),
        table(
          '| ID | Title | Status | Acceptance |',
          '| --- | --- | --- | --- |',
          '| `A-001` | done | `[x]` | a test |',
          '| `A-002` | open | `[ ]` | a test to write |',
          '',
        ),
      );
      const page = render(buildReport(dir));
      // Assert the row's meaning, not its padding: column widths are the generator's business,
      // and a test that pins them fails the moment a longer task title widens a column.
      const row = (label: string): string | undefined =>
        page
          .split('\n')
          .find((line) => line.startsWith(`| ${label}`))
          ?.split('|')[2]
          ?.trim();
      expect(row('done')).toBe('1');
      expect(row('open')).toBe('1');
      // The open list is the point of the page: an id and where it lives.
      expect(page).toContain('`A-002`');
      expect(page).not.toContain('`A-001` |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doc-inventory measures what it claims to', () => {
  test('a heading with no body is an empty section', () => {
    const source = table('## One', '', '## Two', 'body', '', '### Three', '');
    expect(emptySectionsIn(source)).toBe(2);
    expect(countExamples(source)).toBe(0);
  });

  test('a fenced ts block is an example; a fence with no language is not', () => {
    const source = table('## Example', '```ts', 'const x = 1;', '```', '```', 'prose', '```');
    expect(countExamples(source)).toBe(1);
  });
});
