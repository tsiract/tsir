import { describe, expect, test } from 'bun:test';

import { readmeProblems } from './check-dist.ts';

/**
 * A README that satisfies the rule, so each test below can break exactly one thing.
 *
 * Kept as a template rather than a fixture file: the point of the rule is that the real README is
 * generated, so the thing under test is the comparison, not the file on disk.
 */
const GOOD = `# Tsir distribution

\`\`\`text
├── templates/       # one Vite frontend per configured framework
\`\`\`

- \`templates/svelte\` — tailwind, SPA router, dev on 5173
- \`templates/react\` — tailwind, SPA router, dev on 5174

Run \`./tsir --help\`. Use \`tsir new my-app\` to create an application.
`;

describe('tools · the distribution README describes the distribution', () => {
  test('a README that names the templates and the first command is clean', () => {
    expect(readmeProblems(GOOD, ['svelte', 'react'])).toEqual([]);
  });

  test('a shipped template the README never names is reported', () => {
    // The shipped defect: templates landed in `dist/` while the README listed none of them.
    const problems = readmeProblems(GOOD, ['svelte', 'react', 'vue']);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('templates/vue');
  });

  test('a README that never mentions `templates/` at all is reported once', () => {
    // Both the tree line and the two bullets have to go: the rule looks for the path, not the word.
    const readme = GOOD.replaceAll('templates/', 'frontends/');
    const problems = readmeProblems(readme, []);
    expect(problems.some((problem) => problem.detail.includes('never mentions `templates/`'))).toBe(
      true,
    );
  });

  test('the first command and the scaffold are required too', () => {
    const bare = '# Tsir distribution\n\nIncludes templates/svelte.\n';
    const problems = readmeProblems(bare, ['svelte']);
    const details = problems.map((problem) => problem.detail).join('\n');
    expect(details).toContain('`tsir new`');
    expect(details).toContain('`--help`');
    expect(details).not.toContain('templates/svelte');
  });

  test('every problem names the readme rule, so the fix is obvious from the output', () => {
    for (const problem of readmeProblems('', ['vue'])) {
      expect(problem.rule).toBe('readme');
    }
  });
});
