import { describe, expect, test } from 'bun:test';
import { renderIndex, renderPage, uncoveredCodes } from './package-pages.ts';

const pkg = { dir: 'queue', name: '@tsir/queue', description: '' };
const surface = {
  queue: ['Queue', 'createQueue'],
  'queue:memory': ['memoryQueueDriver'],
  'queue:sqs': [],
  cache: ['Cache'],
};
const codes = { QUEUE_JOB_UNKNOWN: 'queue', QUEUE_DEAD: 'queue', CACHE_MISS: 'cache' };

describe('renderPage (DOC-010)', () => {
  test('the install line uses the package name', () => {
    expect(renderPage(pkg, surface, codes)).toContain("bun add '@tsir/queue@workspace:*'");
  });

  test('the barrel is listed first, then subpaths by name', () => {
    const page = renderPage(pkg, surface, codes);
    const barrel = page.indexOf('**`@tsir/queue`**');
    const memory = page.indexOf('**`@tsir/queue/memory`**');
    const sqs = page.indexOf('**`@tsir/queue/sqs`**');
    expect(barrel).toBeGreaterThan(-1);
    expect(barrel).toBeLessThan(memory);
    expect(memory).toBeLessThan(sqs);
  });

  test('another package’s surface and codes are not listed', () => {
    const page = renderPage(pkg, surface, codes);
    expect(page).not.toContain('CACHE_MISS');
    expect(page).not.toContain('@tsir/queue/cache');
  });

  test('a subpath with no named exports says so', () => {
    expect(renderPage(pkg, surface, codes)).toContain('_No named exports._');
  });

  test('owned codes are listed, and their absence is stated', () => {
    const page = renderPage(pkg, surface, codes);
    expect(page).toContain('- `QUEUE_DEAD`');
    expect(
      renderPage({ dir: 'vault', name: '@tsir/vault', description: '' }, { vault: ['x'] }, codes),
    ).toContain('raises no error codes');
  });

  test('the sections nobody has written yet are marked pending, not left blank', () => {
    const page = renderPage(pkg, surface, codes);
    expect(page).toContain('## Example');
    expect(page).toContain('## Failure modes');
    expect(page).toContain('## Security notes');
    expect(page.match(/_Pending:/gu)).toHaveLength(3);
  });

  test('the same inputs give the same bytes', () => {
    expect(renderPage(pkg, surface, codes)).toBe(renderPage(pkg, surface, codes));
  });
});

describe('uncoveredCodes (every owned code is explained)', () => {
  const codes = { CFG_A: 'config', CFG_B: 'config', CAP_X: 'cache' };
  const prose = [
    '## Example',
    '',
    'Something.',
    '',
    '## Failure modes',
    '',
    '- `CFG_A`: explained.',
    '',
    '## Security notes',
    '',
    'Mentions `CFG_B` outside the failure modes, which does not count.',
    '',
  ].join('\n');

  test('lists owned codes that the Failure modes section does not name', () => {
    expect(uncoveredCodes('config', codes, prose)).toEqual(['CFG_B']);
  });

  test('ignores codes owned by other packages', () => {
    expect(uncoveredCodes('cache', codes, prose)).toEqual(['CAP_X']);
  });
});

describe('package index', () => {
  test('every package appears exactly once, with its manifest description', () => {
    const pages = [
      { dir: 'queue', name: '@tsir/queue', description: 'Named job connections.' },
      { dir: 'cache', name: '@tsir/cache', description: 'Named cache stores.' },
      { dir: 'made-up', name: '@tsir/made-up', description: '' },
    ];
    const out = renderIndex(pages);
    for (const name of ['@tsir/queue', '@tsir/cache', '@tsir/made-up']) {
      expect(out.split(name)).toHaveLength(2); // once, and only once
    }
    expect(out).toContain('Named job connections.');
  });

  test('a group without members is dropped rather than printed empty', () => {
    // The index is hand-grouped by job, so a group can empty out when a package is renamed.
    // A heading with nothing under it reads as a broken page.
    const out = renderIndex([{ dir: 'core', name: '@tsir/core', description: '' }]);
    expect(out).toContain('## Foundations');
    expect(out).not.toContain('## Services');
    expect(out).not.toContain('## Other');
  });

  test('a package matching no group still appears, rather than vanishing', () => {
    const out = renderIndex([{ dir: 'unexpected', name: '@tsir/unexpected', description: '' }]);
    expect(out).toContain('## Other');
    expect(out).toContain('@tsir/unexpected');
  });
});
